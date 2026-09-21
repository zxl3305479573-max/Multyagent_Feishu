import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTaskRecord } from "./task.js";
import { transition } from "./task-state.js";

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

export class TaskStore {
  constructor(file = "runtime/domain-tasks.json") {
    this.file = file;
    this.state = { tasks: {}, byIdempotencyKey: {} };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.state = { tasks: {}, byIdempotencyKey: {} };
    }
    this.state.tasks ||= {};
    this.state.byIdempotencyKey ||= {};
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

  async get(taskId) {
    await this.load();
    return clone(this.state.tasks[taskId]);
  }

  async findByIdempotencyKey(key) {
    await this.load();
    const taskId = key && this.state.byIdempotencyKey[key];
    return taskId ? clone(this.state.tasks[taskId]) : null;
  }

  async update(taskId, patch = {}) {
    await this.load();
    const task = this.state.tasks[taskId];
    if (!task) return null;
    Object.assign(task, patch, { updated_at: new Date().toISOString() });
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
