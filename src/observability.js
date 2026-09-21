import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createEventLogger(file = "runtime/events.jsonl") {
  return async function record(event = {}) {
    const entry = { timestamp: new Date().toISOString(), ...event };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`);
    return entry;
  };
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
