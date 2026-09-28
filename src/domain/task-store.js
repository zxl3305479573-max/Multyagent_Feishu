import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTaskRecord } from "./task.js";
import { transition } from "./task-state.js";

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

const TERMINAL_SNAPSHOT_STATUSES = new Set(["completed", "failed"]);
const PROJECT_DECISION_EVENTS = new Set([
  "delivery_received",
  "task_completed",
  "dispatch_started",
  "dispatch_completed",
  "approval_required",
]);

function rootOf(taskId) { return String(taskId || "").split(":")[0]; }

function snapshotStatus(event = {}) {
  if (["task_failed", "dispatch_failed", "selection_failed", "continuation_failed"].includes(event.type)) return "failed";
  if (event.type === "task_hold") return "paused";
  if (event.type === "approval_required") return "awaiting_approval";
  if (event.type === "task_settle" || (event.type === "task_completed" && event.final === true)) return "completed";
  if (["task_started", "agent_started", "dispatch_started", "delivery_received", "dispatch_completed"].includes(event.type)) return "in_progress";
  return null;
}

function emptySnapshot(taskId) {
  return { task_id: taskId, status: "not_found", active_agents: [], latest_event: null, updated_at: null, project_name: null, error: null, blockers: [], risks: [] };
}

function projectNameForEvent(event, task, current) {
  if (event.project_name && (PROJECT_DECISION_EVENTS.has(event.type) || !task.project_name && !current.project_name)) {
    return event.project_name;
  }
  return task.project_name || current.project_name || null;
}

export class TaskStore {
  constructor(file = "runtime/domain-tasks.json") {
    this.file = file;
    this.state = { tasks: {}, byIdempotencyKey: {}, aliases: {}, recent: {} };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.state = { tasks: {}, byIdempotencyKey: {}, aliases: {}, recent: {} };
    }
    this.state.tasks ||= {};
    this.state.byIdempotencyKey ||= {};
    this.state.aliases ||= {};
    this.state.recent ||= {};
    for (const task of Object.values(this.state.tasks)) {
      if (task.root_key && task.agent) this.state.aliases[`${task.agent}:${task.root_key}`] ||= task.task_id;
      if (task.agent && task.source_chat_id) {
        const key = `${task.agent}:${task.source_chat_id}`;
        const current = this.state.tasks[this.state.recent[key]];
        if (!current || Date.parse(task.updated_at || 0) >= Date.parse(current.updated_at || 0)) this.state.recent[key] = task.task_id;
      }
    }
    // Ignore malformed persisted indexes; task records remain recoverable.
    for (const [key, taskId] of Object.entries(this.state.byIdempotencyKey)) {
      if (!this.state.tasks[taskId]) delete this.state.byIdempotencyKey[key];
    }
    this.loaded = true;
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2));
    });
    await this.writeChain;
  }

  async create(input = {}) {
    await this.load();
    const key = input.idempotency_key || null;
    if (key && this.state.byIdempotencyKey[key]) {
      return clone(this.state.tasks[this.state.byIdempotencyKey[key]]);
    }

    const task = createTaskRecord(input);
    this.state.tasks[task.task_id] = task;
    if (key) this.state.byIdempotencyKey[key] = task.task_id;
    await this.persist();
    return clone(task);
  }

  async migrateLegacyFile(file) {
    await this.load();
    if (!file || file === this.file) return { imported: 0 };
    let legacy;
    try { legacy = JSON.parse(await readFile(file, "utf8")); } catch { return { imported: 0 }; }
    const tasks = legacy?.tasks && typeof legacy.tasks === "object" ? legacy.tasks : {};
    let imported = 0;
    for (const old of Object.values(tasks)) {
      const taskId = old?.taskId || old?.task_id;
      if (!taskId || this.state.tasks[taskId]) continue;
      const task = createTaskRecord({
        task_id: taskId,
        agent: old.agentKey || old.agent,
        requested_role: old.agentKey || old.requested_role || old.agent,
        source_chat_id: old.chatId || old.source_chat_id,
        source_message_id: old.firstMessageId || old.messageId || old.source_message_id,
        root_key: old.rootKey || old.root_key,
        session_file: old.sessionFile || old.session_file,
        project_name: old.projectName || old.project_name,
        last_message_id: old.lastMessageId || old.last_message_id,
        status: old.status || "received",
        paused: old.paused === true,
        terminated: old.terminated === true,
        created_at: old.createdAt ? new Date(old.createdAt).toISOString() : undefined,
        updated_at: old.updatedAt ? new Date(old.updatedAt).toISOString() : undefined,
      });
      this.state.tasks[task.task_id] = task;
      if (task.agent && task.root_key) this.state.aliases[`${task.agent}:${task.root_key}`] = task.task_id;
      if (task.agent && task.source_chat_id) this.state.recent[`${task.agent}:${task.source_chat_id}`] = task.task_id;
      imported += 1;
    }
    for (const [key, taskId] of Object.entries(legacy?.byRoot || {})) {
      if (!this.state.aliases[key] && this.state.tasks[taskId]) this.state.aliases[key] = taskId;
    }
    for (const [key, taskId] of Object.entries(legacy?.recent || {})) {
      if (!this.state.recent[key] && this.state.tasks[taskId]) this.state.recent[key] = taskId;
    }
    if (imported) await this.persist();
    return { imported };
  }

  async get(taskId) {
    await this.load();
    return clone(this.state.tasks[taskId]);
  }

  async getRoot(taskId) {
    const rootId = String(taskId || "").split(":")[0];
    return rootId ? this.get(rootId) : null;
  }

  async findByIdempotencyKey(key) {
    await this.load();
    const taskId = key && this.state.byIdempotencyKey[key];
    return taskId ? clone(this.state.tasks[taskId]) : null;
  }

  async findByAlias(agentKey, rootKey) {
    await this.load();
    const taskId = rootKey && this.state.aliases[`${agentKey}:${rootKey}`];
    return taskId ? clone(this.state.tasks[taskId]) : null;
  }

  async linkAlias(agentKey, rootKey, taskId) {
    await this.load();
    if (!agentKey || !rootKey || !this.state.tasks[taskId]) return null;
    this.state.aliases[`${agentKey}:${rootKey}`] = taskId;
    await this.persist();
    return clone(this.state.tasks[taskId]);
  }

  async setRecent(agentKey, chatId, taskId) {
    await this.load();
    if (!agentKey || !chatId || !this.state.tasks[taskId]) return null;
    this.state.recent[`${agentKey}:${chatId}`] = taskId;
    await this.persist();
    return clone(this.state.tasks[taskId]);
  }

  async findRecent(agentKey, chatId, ttlMs) {
    await this.load();
    const taskId = chatId && this.state.recent[`${agentKey}:${chatId}`];
    const task = taskId ? this.state.tasks[taskId] : null;
    if (!task) return null;
    if (ttlMs && Date.now() - Date.parse(task.updated_at) > ttlMs) return null;
    return clone(task);
  }

  async update(taskId, patch = {}) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    Object.assign(task, patch, { updated_at: new Date().toISOString() });
    if (Object.prototype.hasOwnProperty.call(patch, "project_name") && task.status_snapshot) {
      task.status_snapshot = {
        ...task.status_snapshot,
        project_name: patch.project_name || null,
      };
    }
    await this.persist();
    return clone(task);
  }

  async applyEvent(event = {}) {
    await this.load();
    const rootTaskId = rootOf(event.task_id || event.parent_task_id);
    if (!rootTaskId || !this.state.tasks[rootTaskId]) return null;
    const task = this.state.tasks[rootTaskId];
    const current = task.status_snapshot || emptySnapshot(rootTaskId);
    const nextStatus = snapshotStatus(event);
    if (TERMINAL_SNAPSHOT_STATUSES.has(current.status) && !["control_applied", "task_terminated", "task_resumed"].includes(event.type)) return clone(current);

    const active = new Set(current.active_agents || []);
    const agent = event.target || event.agent || null;
    if (["task_started", "agent_started", "dispatch_started", "approval_required"].includes(event.type) && agent) active.add(agent);
    if (["dispatch_completed", "dispatch_failed", "agent_finished"].includes(event.type) && agent) active.delete(agent);
    if (["task_failed", "task_settle", "task_terminated"].includes(event.type) || (event.type === "task_completed" && event.final === true)) active.clear();

    const snapshot = {
      ...current,
      task_id: rootTaskId,
      status: nextStatus || current.status,
      active_agents: [...active],
      latest_event: nextStatus || event.type === "control_applied" || event.type === "task_resumed" ? event.type : current.latest_event,
      updated_at: event.timestamp || new Date().toISOString(),
      project_name: projectNameForEvent(event, task, current),
      error: event.error || current.error || null,
      blockers: Array.isArray(event.blockers) && event.blockers.length ? event.blockers : current.blockers || [],
      risks: Array.isArray(event.risks) && event.risks.length ? event.risks : current.risks || [],
    };
    task.status_snapshot = snapshot;
    task.updated_at = snapshot.updated_at;
    await this.persist();
    return clone(snapshot);
  }

  async setPaused(taskId, paused) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    if (task.terminated && !paused) return clone(task);
    task.paused = Boolean(paused);
    task.updated_at = new Date().toISOString();
    await this.persist();
    return clone(task);
  }

  async setTerminated(taskId, terminated = true) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    if (task.terminated && !terminated) return clone(task);
    task.terminated = Boolean(terminated);
    if (task.terminated) task.paused = false;
    task.updated_at = new Date().toISOString();
    await this.persist();
    return clone(task);
  }

  async recoverRunning() {
    await this.load();
    const recovered = [];
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === "running") {
        task.status = "retrying";
        task.updated_at = new Date().toISOString();
        recovered.push(task.task_id);
      }
    }
    if (recovered.length) await this.persist();
    return recovered;
  }

  async count() {
    await this.load();
    return Object.keys(this.state.tasks).length;
  }

  async transition(taskId, nextStatus) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    transition(task.status, nextStatus);
    task.status = nextStatus;
    task.updated_at = new Date().toISOString();
    await this.persist();
    return clone(task);
  }

  async list() {
    await this.load();
    return Object.values(this.state.tasks).map(clone);
  }

  async getStatus(taskId, chatId = null) {
    await this.load();
    const rootTaskId = rootOf(taskId);
    const task = rootTaskId ? this.state.tasks[rootTaskId] : null;
    if (!task || (chatId && task.source_chat_id && task.source_chat_id !== chatId)) return emptySnapshot(rootTaskId || taskId);
    return clone(task.status_snapshot || {
      ...emptySnapshot(rootTaskId),
      status: task.status || "received",
      project_name: task.project_name || null,
      updated_at: task.updated_at || null,
    });
  }

  async claim(taskId, { leaseMs = 900_000, owner = "orchestrator" } = {}) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    const now = Date.now();
    if (task.lease_until && task.lease_until > now && task.lease_owner !== owner) return null;
    task.lease_owner = owner;
    task.lease_until = now + leaseMs;
    task.updated_at = new Date(now).toISOString();
    await this.persist();
    return clone(task);
  }

  async release(taskId, owner = "orchestrator") {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task || (task.lease_owner && task.lease_owner !== owner)) return null;
    delete task.lease_owner;
    delete task.lease_until;
    task.updated_at = new Date().toISOString();
    await this.persist();
    return clone(task);
  }

  async retry(taskId, error = "") {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    if (task.attempt >= task.max_attempts) return clone(task);
    if (!["failed", "running", "retrying"].includes(task.status)) return clone(task);
    task.attempt += 1;
    task.error = String(error || task.error || "");
    task.status = "retrying";
    task.updated_at = new Date().toISOString();
    await this.persist();
    return clone(task);
  }
}
