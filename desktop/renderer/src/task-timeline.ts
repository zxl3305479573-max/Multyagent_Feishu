import type { AgentExecutionGroup, EventRecord } from "./types";
import { eventLabels } from "./labels";
import { latestPlanProgress, type PlanProgress } from "./execution-view";
import { taskStatusToken } from "./themes/task-status";

export type TaskTimelineState = "done" | "active" | "waiting" | "error";

export type TaskTimelineItem = {
  id: string;
  type: string;
  label: string;
  detail: string;
  status: TaskTimelineState;
  timestamp?: string;
};

const TIMELINE_EVENTS = new Set([
  "task_created",
  "task_started",
  "task_plan_created",
  "plan_progress",
  "approval_required",
  "dispatch_started",
  "dispatch_completed",
  "dispatch_failed",
  "agent_started",
  "agent_finished",
  "tool_call",
  "tool_result",
  "test_started",
  "test_result",
  "delivery_received",
  "task_hold",
  "task_resumed",
  "task_failed",
  "task_completed",
  "task_settle",
  "final_summary",
]);

const ERROR_EVENTS = new Set(["task_failed", "dispatch_failed", "error", "continuation_failed", "selection_failed"]);
const DONE_EVENTS = new Set(["task_completed", "task_settle", "final_summary", "delivery_received", "dispatch_completed", "agent_finished", "tool_result"]);

export function buildTaskTimeline(events: EventRecord[], taskStatus?: string | null, limit = 12): TaskTimelineItem[] {
  const filtered = events.filter((event) => TIMELINE_EVENTS.has(event.type || ""));
  const selected = filtered.slice(-Math.max(1, limit));
  const rootToken = taskStatusToken(taskStatus);
  const lastIndex = selected.length - 1;
  return selected.map((event, index) => {
    const type = event.type || "event";
    const isLast = index === lastIndex;
    let status: TaskTimelineState = "done";
    if (ERROR_EVENTS.has(type) || event.status === "failed") status = "error";
    else if (type === "approval_required" && isLast) status = "waiting";
    else if (isLast && ["running", "planning", "waiting-approval", "pending"].includes(rootToken)) status = "active";
    else if (DONE_EVENTS.has(type)) status = "done";
    const detail = type === "plan_progress"
      ? planProgressText(events)
      : event.summary || event.error || event.text || event.tool || "";
    return {
      id: event.event_id || `${type}-${index}`,
      type,
      label: eventLabels[type] || type,
      detail: String(detail).slice(0, 180),
      status,
      timestamp: event.timestamp,
    };
  });
}

function planProgressText(events: EventRecord[]) {
  const progress = latestPlanProgress(events);
  return progress ? `计划 ${progress.completed}/${progress.total} 完成${progress.running ? ` · ${progress.running} 项执行中` : ""}` : "计划进度已更新";
}

export type TaskProgressSummary = {
  percent: number;
  label: string;
  completed: number;
  total: number;
  plan: PlanProgress | null;
};

export function summarizeTaskProgress(events: EventRecord[], groups: AgentExecutionGroup[], taskStatus?: string | null): TaskProgressSummary {
  const plan = latestPlanProgress(events);
  if (plan) {
    const completed = plan.completed;
    return {
      plan,
      completed,
      total: plan.total,
      percent: plan.total ? Math.round((completed / plan.total) * 100) : 0,
      label: `${completed}/${plan.total} 个切片完成`,
    };
  }
  const total = groups.length;
  const completed = groups.filter((group) => group.status === "completed").length;
  if (total) {
    return { plan: null, completed, total, percent: Math.round((completed / total) * 100), label: `${completed}/${total} 个 Agent 完成` };
  }
  const token = taskStatusToken(taskStatus);
  return {
    plan: null,
    completed: token === "completed" ? 1 : 0,
    total: token === "completed" ? 1 : 0,
    percent: token === "completed" ? 100 : 0,
    label: token === "completed" ? "任务已完成" : "等待执行数据",
  };
}
