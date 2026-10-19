// @ts-check
import { readFile } from "node:fs/promises";
import { readJsonFile, writeFileAtomic } from "../atomic-file.cjs";
import { createTaskRecord } from "./task.js";
import { transition } from "./task-state.js";
import { createQualityGates, reduceQualityGates } from "../quality-gates.js";

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

const TERMINAL_SNAPSHOT_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PROJECT_DECISION_EVENTS = new Set([
  "delivery_received",
  "task_completed",
  "dispatch_started",
  "dispatch_completed",
  "approval_required",
]);

function rootOf(taskId) { return String(taskId || "").split(":")[0]; }

function snapshotStatus(event = {}) {
  if (event.type === "task_retried") return "in_progress";
  if (event.type === "task_reopened") return "in_progress";
  if (event.type === "dispatch_failed" && event.recoverable === true) return null;
  if (["task_failed", "dispatch_failed", "selection_failed", "continuation_failed"].includes(event.type)) return "failed";
  if (["task_terminated", "task_cancelled"].includes(event.type)) return "cancelled";
  if (event.type === "task_hold") return "paused";
  if (event.type === "approval_required") return "awaiting_approval";
  if ((event.type === "task_settle" || event.type === "task_completed" && event.final === true) && event.task_id === rootOf(event.task_id)) return "completed";
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
  constructor(file = "runtime/domain-tasks.json", { snapshotFlushMs = 250, log = console } = {}) {
    this.file = file;
    this.state = { tasks: {}, byIdempotencyKey: {}, aliases: {}, recent: {} };
    this.loaded = false;
    this.loading = null;
    this.dirty = false;
    this.flushing = null;
    this.flushTimer = null;
    this.snapshotFlushMs = snapshotFlushMs;
    this.log = log;
  }

  async load() {
    if (this.loaded) return;
    // 并发首次访问共用同一次加载，避免重复读盘或互相覆盖。
    this.loading ||= this.#loadOnce().finally(() => { this.loading = null; });
    await this.loading;
  }

  async #loadOnce() {
    if (this.loaded) return;
    // 解析失败时备份坏文件并抛错：宁可拒绝启动，也不能用空状态覆盖历史任务。
    const parsed = await readJsonFile(this.file, { fallback: null, onCorrupt: "throw" });
    this.state = parsed && typeof parsed === "object" ? parsed : { tasks: {}, byIdempotencyKey: {}, aliases: {}, recent: {} };
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

  // 合并写盘：写入进行中再次调用只会标记 dirty，由同一轮循环补写最新状态，
  // 因而高频事件不会排起一长串整文件重写。返回的 Promise 在包含本次修改的写入落盘后完成。
  persist() {
    this.dirty = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushing ||= this.#flushLoop().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #flushLoop() {
    while (this.dirty) {
      this.dirty = false;
      try {
        await writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    }
  }

  // 事件派生的状态快照可由 events.jsonl 重建，延迟合并写盘，不阻塞事件管线。
  schedulePersist() {
    this.dirty = true;
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.persist().catch((error) => this.log?.error?.(`[tasks] snapshot persist failed: ${error.message}`));
    }, this.snapshotFlushMs);
    this.flushTimer.unref?.();
  }

  // 退出前调用，确保延迟中的快照落盘。
  async flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.dirty || this.flushing) await this.persist();
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
    task.quality_gates = reduceQualityGates(task.quality_gates || createQualityGates(task.quality_policy), event);
    const nextStatus = snapshotStatus(event);
    if (TERMINAL_SNAPSHOT_STATUSES.has(current.status) && !["control_applied", "task_terminated", "task_resumed", "task_retried", "task_reopened"].includes(event.type)) return clone(current);

    const active = new Set(current.active_agents || []);
    const agent = event.target || event.agent || null;
    if (["task_started", "agent_started", "dispatch_started", "approval_required"].includes(event.type) && agent) active.add(agent);
    if (["dispatch_completed", "dispatch_failed", "agent_finished"].includes(event.type) && agent) active.delete(agent);
    if (["task_failed", "task_terminated", "task_cancelled"].includes(event.type) || nextStatus === "completed") active.clear();

    const snapshot = {
      ...current,
      task_id: rootTaskId,
      status: nextStatus || current.status,
      active_agents: [...active],
      latest_event: nextStatus || event.type === "control_applied" || event.type === "task_resumed" ? event.type : current.latest_event,
      updated_at: event.timestamp || new Date().toISOString(),
      project_name: projectNameForEvent(event, task, current),
      error: event.type === "task_retried" ? null : (event.recoverable === true ? null : event.error) || current.error || null,
      blockers: Array.isArray(event.blockers) && event.blockers.length ? event.blockers : current.blockers || [],
      risks: Array.isArray(event.risks) && event.risks.length ? event.risks : current.risks || [],
      quality_gates: task.quality_gates,
    };
    task.status_snapshot = snapshot;
    task.updated_at = snapshot.updated_at;
    // 状态变化（开始/待确认/完成/失败等）立即落盘；工具调用等高频事件只刷新
    // 时间与活动角色，延迟合并写盘即可。
    if (snapshot.status !== current.status) await this.persist();
    else this.schedulePersist();
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
      // 任务状态机的 status 实际不会进入 running，真正的进行中标记在事件快照里：
      // 进程重启后没有任何 Agent 还在跑，in_progress 的快照只能是被中断的孤儿。
      const snapshot = task.status_snapshot;
      if (snapshot?.status === "in_progress" && !task.terminated) {
        task.status_snapshot = {
          ...snapshot,
          status: "failed",
          active_agents: [],
          error: snapshot.error || "网关重启时任务仍在执行，已中断",
          updated_at: new Date().toISOString(),
        };
        task.updated_at = task.status_snapshot.updated_at;
        recovered.push(task.task_id);
      }
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
