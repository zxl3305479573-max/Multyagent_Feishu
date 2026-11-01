/** Maps renderer-only status spellings to the shared seven visual status tokens. */
export type TaskStatusToken = "pending" | "planning" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";
export type TaskStatusMood = "happy" | "thinking" | "puzzled" | "surprised" | "sleepy";

/**
 * Pear's view-only expression for each shared task-status token. This does not
 * alter the task status persisted by the gateway or surfaced to automation.
 */
export const taskStatusMoods: Record<TaskStatusToken, TaskStatusMood> = {
  pending: "sleepy",
  planning: "thinking",
  running: "thinking",
  "waiting-approval": "puzzled",
  completed: "happy",
  failed: "surprised",
  cancelled: "sleepy",
};

export function taskStatusToken(status?: string | null): TaskStatusToken {
  const value = (status || "").toLowerCase();
  if (["completed", "passed", "done", "success"].includes(value)) return "completed";
  if (["failed", "error"].includes(value)) return "failed";
  if (["cancelled", "terminated", "stopped"].includes(value)) return "cancelled";
  if (["paused", "waiting", "approval_required", "pending_approval"].includes(value)) return "waiting-approval";
  if (["running", "in_progress", "executing"].includes(value)) return "running";
  if (["planning", "planned"].includes(value)) return "planning";
  return "pending";
}

export function taskStatusMood(status?: string | null): TaskStatusMood {
  return taskStatusMoods[taskStatusToken(status)];
}
