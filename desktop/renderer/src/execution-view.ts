export type ExecutionEvent = {
  type?: string;
  timestamp?: string;
  final?: boolean;
  agent?: string;
  target?: string;
  from?: string;
  tool?: string;
  tool_call_id?: string;
  task_id?: string;
  sub_task_id?: string;
  parent_task_id?: string;
  assignment_id?: string;
  run_id?: string;
  status?: string;
  artifact_paths?: string[];
  artifact_items?: Array<{ path?: string; description?: string; type?: string; size?: number }>;
};

export type ExecutionItem<E extends ExecutionEvent> =
  | { kind: "event"; event: E }
  | { kind: "tool"; execution: { tool: string; events: E[] } };

export type ConversationTurn<E extends ExecutionEvent> = {
  turn: number;
  userEvent: E | null;
  events: E[];
};

export type AgentExecutionInstance<E extends ExecutionEvent> = {
  agentKey: string;
  executionId: string;
  events: E[];
};

export function isUserInputEvent(event: ExecutionEvent) {
  return ["task_created", "task_reused"].includes(event.type || "");
}

/** Split a task timeline at each user message so later executions stay below the input that caused them. */
export function splitConversationTurns<E extends ExecutionEvent>(events: E[]): ConversationTurn<E>[] {
  const turns: ConversationTurn<E>[] = [];
  let current: ConversationTurn<E> | null = null;
  for (const event of [...events].sort((left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""))) {
    if (isUserInputEvent(event)) {
      if (current?.userEvent === null) current.userEvent = event;
      else {
        current = { turn: turns.length, userEvent: event, events: [] };
        turns.push(current);
      }
      continue;
    }
    if (!current) {
      current = { turn: turns.length, userEvent: null, events: [] };
      turns.push(current);
    }
    current.events.push(event);
  }
  return turns;
}

/** The task id identifies one dispatched child bot; dispatch snapshots also carry it in sub_task_id. */
export function executionInstanceId(event: ExecutionEvent) {
  const primary = event.type?.startsWith("dispatch_") ? event.sub_task_id || event.task_id : event.task_id || event.sub_task_id;
  return primary || event.run_id || "";
}

/** Keep same-role children separate instead of merging every frontend/backend slice into one execution card. */
export function groupAgentExecutionInstances<E extends ExecutionEvent>(events: E[]): AgentExecutionInstance<E>[] {
  const groups = new Map<string, AgentExecutionInstance<E>>();
  for (const event of events) {
    const agentKey = executionOwner(event);
    const executionId = executionInstanceId(event);
    const key = `${agentKey}|${executionId}`;
    const group = groups.get(key) || { agentKey, executionId, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

type NumberableExecutionGroup = { agentKey: string; executionId: string; displayName: string };

/** Number distinct same-role child bots by first appearance; continuing the same child keeps its number. */
export function numberAgentInstances<T extends NumberableExecutionGroup>(groups: T[]): T[] {
  const identities = new Map<string, string[]>();
  for (const group of groups) {
    const keys = identities.get(group.agentKey) || [];
    const identity = group.executionId || `${group.agentKey}:default`;
    if (!keys.includes(identity)) keys.push(identity);
    identities.set(group.agentKey, keys);
  }
  return groups.map((group) => {
    const keys = identities.get(group.agentKey) || [];
    if (keys.length < 2) return group;
    const identity = group.executionId || `${group.agentKey}:default`;
    const index = keys.indexOf(identity);
    return { ...group, displayName: `${index + 1}号${group.displayName}` };
  });
}

/** Match by invocation ID; old logs fall back to FIFO within the same task, run and tool. */
export function groupToolExecutions<E extends ExecutionEvent>(events: E[]): ExecutionItem<E>[] {
  const items: ExecutionItem<E>[] = [];
  const calls = new Map<string, { tool: string; events: E[] }>();
  const pending = new Map<string, Array<{ tool: string; events: E[] }>>();
  const lastCompleted = new Map<string, { tool: string; events: E[] }>();
  const relatedTypes = new Set(["tool_result", "test_started", "test_result", "file_change", "error"]);
  for (const event of events) {
    // 切片进度快照由标题栏的“切片”状态展示，不进对话时间线。
    if (event.type === "plan_progress") continue;
    const scope = `${event.run_id || ""}:${event.task_id || ""}:${event.tool || ""}`;
    const id = event.tool_call_id ? `${scope}:${event.tool_call_id}` : "";
    if (event.type === "tool_call") {
      const execution = { tool: event.tool || "工具", events: [event] };
      items.push({ kind: "tool", execution });
      if (id) calls.set(id, execution);
      pending.set(scope, [...(pending.get(scope) || []), execution]);
      lastCompleted.delete(scope);
      continue;
    }
    if (!relatedTypes.has(event.type || "")) { items.push({ kind: "event", event }); continue; }
    const queue = pending.get(scope) || [];
    const execution = id ? calls.get(id)
      : ["file_change", "test_result", "error"].includes(event.type || "")
        ? lastCompleted.get(scope) || queue[0] : queue[0];
    if (!execution) { items.push({ kind: "event", event }); continue; }
    execution.events.push(event);
    if (event.type === "tool_result") {
      pending.set(scope, queue.filter((item) => item !== execution));
      lastCompleted.set(scope, execution);
    }
  }
  return items;
}

export function toolExecutionStatus(events: ExecutionEvent[]) {
  if (events.some((event) => event.status === "failed" || event.type === "error")) return "failed";
  return events.some((event) => event.type === "tool_result") ? "completed" : "running";
}

/** Description metadata must never hide paths omitted from artifact_items. */
export function collectArtifacts(event: ExecutionEvent) {
  const items = new Map<string, { path: string; description: string; type?: string; size?: number }>();
  const keyFor = (path: string) => path.replaceAll("\\", "/");
  for (const path of event.artifact_paths || []) {
    if (path) items.set(keyFor(path), { path, description: "尚未提供文件内容说明" });
  }
  for (const item of event.artifact_items || []) {
    if (!item.path) continue;
    const key = keyFor(item.path);
    items.set(key, { ...items.get(key), ...item, path: item.path, description: item.description || items.get(key)?.description || "尚未提供文件内容说明" });
  }
  return [...items.values()];
}

export function executionOwner(event: ExecutionEvent) {
  return event.type?.startsWith("dispatch_")
    ? event.target || event.agent || event.from || "project_manager"
    : event.agent || event.target || "project_manager";
}

export function agentStatus(events: ExecutionEvent[], rootStatus?: string) {
  if (!events.length) return "waiting";
  let status = "waiting";
  for (const event of events) {
    if (["task_failed", "dispatch_failed", "continuation_failed", "selection_failed"].includes(event.type || "")) status = "failed";
    else if (["task_cancelled", "task_terminated", "dispatch_cancelled"].includes(event.type || "")) status = "cancelled";
    else if (event.type === "task_hold") status = "paused";
    else if (event.type === "approval_required") status = "waiting";
    else if (["task_started", "agent_started", "dispatch_started", "task_resumed"].includes(event.type || "")) status = "running";
    else if (["agent_finished", "dispatch_completed", "task_settle", "delivery_received"].includes(event.type || "") || event.type === "task_completed" && event.final === true) {
      if (!["failed", "cancelled"].includes(status)) status = "completed";
    }
  }
  if (["running", "waiting", "paused"].includes(status)) {
    if (["completed", "failed", "cancelled"].includes(rootStatus || "")) return rootStatus!;
    if (rootStatus === "paused") return "paused";
    if (rootStatus === "awaiting_approval" || rootStatus === "awaiting_choice") return "waiting";
  }
  return status;
}

export function executionTiming(events: ExecutionEvent[], now: number, settledAt?: string) {
  const actual = events.filter((event) => ["agent_started", "agent_finished"].includes(event.type || ""));
  const lifecycle = actual.length ? actual : events.filter((event) =>
    ["dispatch_started", "dispatch_completed", "dispatch_failed", "dispatch_cancelled", "task_started", "task_failed", "task_cancelled", "task_terminated", "task_settle"].includes(event.type || "") || event.type === "task_completed" && event.final === true);
  let open: number | null = null;
  let total = 0;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  for (const event of lifecycle) {
    const time = Date.parse(event.timestamp || "");
    if (!Number.isFinite(time)) continue;
    if (["agent_started", "dispatch_started", "task_started"].includes(event.type || "")) {
      startedAt ||= event.timestamp;
      open ??= time;
      endedAt = undefined;
    } else if (open !== null) {
      total += Math.max(0, time - open);
      open = null;
      endedAt = event.timestamp;
    }
  }
  if (open !== null) {
    const settled = Date.parse(settledAt || "");
    total += Math.max(0, (Number.isFinite(settled) ? settled : now) - open);
    if (Number.isFinite(settled)) endedAt = settledAt;
  }
  return { startedAt, endedAt, durationMs: startedAt ? total : null };
}

export type PlanSlice = { id: string; agent: string; title: string; status: "pending" | "running" | "completed" | "failed" | "interrupted" };
export type PlanProgress = { total: number; completed: number; running: number; failed: number; slices: PlanSlice[] };

/** 编排层每次切片状态变化都会发一条 plan_progress 快照；取最新一条，计划被放弃（cleared）时不显示。 */
export function latestPlanProgress(events: Array<ExecutionEvent & { slices?: PlanSlice[]; cleared?: boolean }>): PlanProgress | null {
  const latest = [...events].reverse().find((event) => event.type === "plan_progress");
  if (!latest || latest.cleared || !Array.isArray(latest.slices) || latest.slices.length < 2) return null;
  const count = (status: PlanSlice["status"]) => latest.slices!.filter((slice) => slice.status === status).length;
  return { total: latest.slices.length, completed: count("completed"), running: count("running"), failed: count("failed"), slices: latest.slices };
}
