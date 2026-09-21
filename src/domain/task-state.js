export const TASK_STATES = [
  "received",
  "classified",
  "planned",
  "waiting_approval",
  "ready",
  "running",
  "blocked",
  "failed",
  "succeeded",
  "completed",
  "cancelled",
  "retrying",
  "waiting_dependency",
  "waiting_input",
];

const TRANSITIONS = {
  received: ["classified", "planned", "cancelled"],
  classified: ["planned", "waiting_input", "failed", "cancelled"],
  planned: ["waiting_approval", "ready", "waiting_input", "failed", "cancelled"],
  waiting_approval: ["ready", "planned", "cancelled"],
  ready: ["running", "waiting_dependency", "cancelled"],
  waiting_dependency: ["ready", "cancelled"],
  waiting_input: ["planned", "cancelled"],
  running: ["blocked", "failed", "succeeded", "cancelled"],
  blocked: ["ready", "failed", "cancelled"],
  failed: ["retrying", "cancelled"],
  retrying: ["ready", "running", "failed", "cancelled"],
  succeeded: ["completed"],
  completed: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function validateTransition(from, to) {
  const allowed = canTransition(from, to);
  return {
    allowed,
    from,
    to,
    error: allowed ? null : `非法任务状态迁移: ${from} -> ${to}`,
  };
}

export function assertTransition(from, to) {
  const result = validateTransition(from, to);
  if (!result.allowed) {
    throw new Error(result.error);
  }
  return to;
}

export function transition(from, to) {
  return assertTransition(from, to);
}

export function isTerminal(status) {
  return status === "completed" || status === "cancelled";
}
