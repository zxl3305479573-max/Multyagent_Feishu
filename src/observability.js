import { appendFile, mkdir } from "node:fs/promises";
import { readEventsTail } from "./event-log.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { redactTraceText } from "./domain/trace.js";

const NEVER_LOG = new Set(["prompt", "system_prompt", "thinking", "tool_output", "content", "result", "input"]);

export function sanitizeLoggedEvent(event = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(event)) {
    if (NEVER_LOG.has(key)) continue;
    if (typeof value === "string" && ["command", "error", "summary", "assigned_task", "text", "next"].includes(key)) {
      const max = key === "text" ? 200 : key === "summary" && event.type === "delivery_received" ? 12000 : 2000;
      safe[key] = redactTraceText(value, max).slice(0, max);
    } else if (key === "artifact_items" && Array.isArray(value)) {
      safe[key] = value.map((item) => ({
        path: redactTraceText(String(item?.path || "")).slice(0, 1000),
        description: redactTraceText(String(item?.description || "")).slice(0, 1000),
        ...(typeof item?.type === "string" ? { type: redactTraceText(item.type).slice(0, 30) } : {}),
        ...(Number.isFinite(item?.size) && item.size >= 0 ? { size: item.size } : {}),
      }));
    } else if (Array.isArray(value) && ["checks", "evidence"].includes(key)) {
      // 验收检查与证据里可能出现命令和输出摘要，逐字段脱敏截断。
      safe[key] = value.slice(0, 30).map((item) => Object.fromEntries(Object.entries(item && typeof item === "object" ? item : {})
        .map(([field, text]) => [field, typeof text === "string" ? redactTraceText(text, 1000).slice(0, 1000) : text])));
    } else if (Array.isArray(value) && ["artifact_paths", "assignments", "choices", "blockers", "risks"].includes(key)) {
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
    const taskStore = typeof options.taskStore === "function" ? options.taskStore() : options.taskStore;
    // Agent 执行事件（tool_call 等）只带 task_id；补上项目名，桌面端按项目订阅和回放时才不会丢掉它们。
    const rootId = String(event.task_id || event.parent_task_id || "").split(":")[0];
    const inferredProject = !event.project_name && rootId && taskStore?.getRoot ? (await taskStore.getRoot(rootId))?.project_name : null;
    const entry = {
      ...sanitizeLoggedEvent(event),
      ...(inferredProject ? { project_name: inferredProject } : {}),
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
    if (taskStore?.applyEvent) await taskStore.applyEvent(entry);
    return entry;
  };
}

export async function queryEvents(file = "runtime/events.jsonl", { taskId, runId, agent, type, limit = 500 } = {}) {
  const root = taskId ? String(taskId).split(":")[0] : null;
  const filter = (event) => !(
    (runId && event.run_id !== runId)
    || (agent && event.agent !== agent)
    || (type && event.type !== type)
    || (root && String(event.task_id || event.parent_task_id || "").split(":")[0] !== root)
  );
  const { events } = await readEventsTail(file, { limit: Math.max(0, Number(limit) || 0), filter });
  return events;
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
