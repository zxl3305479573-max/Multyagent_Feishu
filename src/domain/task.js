import { randomUUID } from "node:crypto";

export function createTaskRecord(input = {}) {
  const now = new Date().toISOString();
  return {
    task_id: input.task_id || randomUUID(),
    project_id: input.project_id || null,
    parent_task_id: input.parent_task_id || null,
    source_message_id: input.source_message_id || null,
    source_chat_id: input.source_chat_id || null,
    root_key: input.root_key || null,
    session_file: input.session_file || null,
    project_name: input.project_name || null,
    last_message_id: input.last_message_id || null,
    requested_role: input.requested_role || input.agent || null,
    agent: input.agent || input.requested_role || null,
    title: input.title || "",
    description: input.description || "",
    status: input.status || "received",
    paused: input.paused === true,
    terminated: input.terminated === true,
    priority: input.priority || "normal",
    depends_on: input.depends_on || [],
    input_artifacts: input.input_artifacts || [],
    acceptance_criteria: input.acceptance_criteria || [],
    attempt: input.attempt || 0,
    max_attempts: input.max_attempts || 2,
    token_budget: input.token_budget || 18000,
    max_input_tokens: input.max_input_tokens || 12000,
    max_output_tokens: input.max_output_tokens || 6000,
    max_turns: input.max_turns || 8,
    max_runtime_seconds: input.max_runtime_seconds || 900,
    idempotency_key: input.idempotency_key || null,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  };
}
