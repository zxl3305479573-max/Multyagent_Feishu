import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { redactTraceText } from "./domain/trace.js";

const NEVER_LOG = new Set(["prompt", "system_prompt", "thinking", "tool_output", "content", "result", "input"]);

export function sanitizeLoggedEvent(event = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(event)) {
    if (NEVER_LOG.has(key)) continue;
    if (typeof value === "string" && ["command", "error", "summary", "assigned_task", "text"].includes(key)) {
      safe[key] = redactTraceText(value).slice(0, key === "text" ? 200 : 2000);
    } else if (Array.isArray(value) && ["artifact_paths", "assignments", "choices"].includes(key)) {
      safe[key] = value.map((item) => typeof item === "string" ? redactTraceText(item).slice(0, 1000) : item);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function createEventLogger(file = "runtime/events.jsonl", options = {}) {
  const runId = options.runId || randomUUID();
  const source = options.source || "gateway";
  let sequence = 0;

  return async function record(event = {}) {
    const entry = {
      ...sanitizeLoggedEvent(event),
      schema_version: 1,
      event_id: randomUUID(),
      run_id: runId,
      sequence: ++sequence,
      pid: process.pid,
      source,
      timestamp: new Date().toISOString(),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`);
    const taskStore = typeof options.taskStore === "function" ? options.taskStore() : options.taskStore;
    if (taskStore?.applyEvent) await taskStore.applyEvent(entry);
    return entry;
  };
}

export async function queryEvents(file = "runtime/events.jsonl", { taskId, runId, agent, type, limit = 500 } = {}) {
  let text;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const root = taskId ? String(taskId).split(":")[0] : null;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (runId && event.run_id !== runId) continue;
    if (agent && event.agent !== agent) continue;
    if (type && event.type !== type) continue;
    if (root && String(event.task_id || event.parent_task_id || "").split(":")[0] !== root) continue;
    events.push(event);
  }
  return events.slice(-Math.max(0, Number(limit) || 0));
}

export function projectTask(task = {}) {
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    title: task.title,
    owner_agent: task.agent || task.requested_role,
    stage: task.stage || task.status,
    status: task.status,
    priority: task.priority,
    progress: task.progress ?? null,
    depends_on: task.depends_on || [],
    current_action: task.current_action || null,
    blocker: task.blocker || null,
    input_artifacts: task.input_artifacts || [],
    output_artifacts: task.output_artifacts || task.artifacts || [],
    attempt: task.attempt || 0,
    token_usage: task.token_usage || null,
    started_at: task.started_at || null,
    updated_at: task.updated_at || null,
    completed_at: task.completed_at || null,
  };
}
