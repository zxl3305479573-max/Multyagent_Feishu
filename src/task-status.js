import { readFile } from "node:fs/promises";

function belongsToRoot(event, taskId) {
  return event?.task_id === taskId
    || event?.parent_task_id === taskId
    || String(event?.task_id || "").startsWith(`${taskId}:`);
}

function statusFor(event) {
  if (["task_failed", "dispatch_failed", "selection_failed"].includes(event.type)) return "failed";
  if (event.type === "task_hold") return "paused";
  if (event.type === "approval_required") return "awaiting_approval";
  if (event.type === "task_settle" || (event.type === "task_completed" && event.final === true)) return "completed";
  if (["task_started", "dispatch_started", "delivery_received", "dispatch_completed"].includes(event.type)) return "in_progress";
  return null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export function summarizeTaskEvents(events, taskId, chatId) {
  const matched = events.filter((event) => belongsToRoot(event, taskId) && (!chatId || event.chat_id === chatId));
  const active = new Set();
  let status = "not_found";
  let latest = null;
  let projectName = null;
  let error = null;
  let blockers = [];
  let risks = [];

  for (const event of matched) {
    // Once a terminal lifecycle event is observed, late trace events from the
    // winding-down session must not reopen or move the task backwards.
    if (TERMINAL_STATUSES.has(status) && !["task_terminated", "control_applied"].includes(event.type)) continue;
    latest = event;
    projectName ||= event.project_name || null;
    const agent = event.target || event.agent;
    if (["task_started", "agent_started", "dispatch_started", "approval_required"].includes(event.type) && agent) active.add(agent);
    if (["dispatch_completed", "dispatch_failed", "agent_finished"].includes(event.type) && agent) active.delete(agent);
    if (["task_settle", "task_failed", "task_terminated"].includes(event.type) || (event.type === "task_completed" && event.final === true)) active.clear();
    if (event.type === "approval_required" && agent) active.add(agent);
    if (event.error) error = event.error;
    if (Array.isArray(event.blockers) && event.blockers.length) blockers = event.blockers;
    if (Array.isArray(event.risks) && event.risks.length) risks = event.risks;
    status = statusFor(event) || status;
  }

  return {
    task_id: taskId,
    project_name: projectName,
    status,
    active_agents: [...active],
    latest_event: latest?.type || null,
    updated_at: latest?.timestamp || null,
    error,
    blockers,
    risks,
  };
}

export async function loadTaskStatus(taskId, chatId, file = process.env.PI_EVENTS_FILE || "runtime/events.jsonl") {
  let events = [];
  try {
    events = (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fromEvents = summarizeTaskEvents(events, taskId, chatId);
  const taskFile = process.env.PI_DOMAIN_TASKS_FILE || process.env.PI_TASKS_FILE || "runtime/domain-tasks.json";
  try {
    const { TaskStore } = await import("./domain/task-store.js");
    const snapshot = await new TaskStore(taskFile).getStatus(taskId, chatId);
    if (snapshot.status !== "not_found" && snapshot.latest_event) {
      return { ...fromEvents, ...snapshot, task_id: taskId };
    }
  } catch {
    // Event history remains the compatibility fallback when no domain store exists.
  }
  return fromEvents;
}
