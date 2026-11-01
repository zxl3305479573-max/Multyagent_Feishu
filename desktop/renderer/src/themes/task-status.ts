/** Maps renderer-only status spellings to the shared seven visual status tokens. */
export type TaskStatusToken = "pending" | "planning" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

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
