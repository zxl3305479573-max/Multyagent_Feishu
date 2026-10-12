import type { DesktopMessage, EventRecord, Task } from "./types";
import { statusLabels } from "./labels";

export function formatProjectCommandFeedback(command: string | undefined, result: DesktopMessage["result"] = {}) {
  if (command === "export_project") return `项目已导出：${result?.outputFile || "已生成导出文件"} · ${Number(result?.taskCount) || 0} 个任务 · ${Number(result?.eventCount) || 0} 条事件`;
  if (command === "cleanup_history") return `历史已归档：归档 ${Number(result?.archived) || 0} 条，保留 ${Number(result?.kept) || 0} 条`;
  if (command === "restore_history") return `历史已恢复：恢复 ${Number(result?.restored) || 0} 条记录`;
  return "";
}

export function rootTaskId(taskId?: string) {
  return String(taskId || "").split(":")[0];
}

export function eventTime(event: EventRecord) {
  const time = event.timestamp ? new Date(event.timestamp).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function taskStatus(task?: Task) {
  const status = task?.status_snapshot?.status || task?.status || "received";
  return statusLabels[status] || status;
}

export function mergeTasks(previous: Task[], incoming: Task[]) {
  const byId = new Map(previous.filter((task) => task.task_id).map((task) => [task.task_id, task]));
  for (const task of incoming) {
    if (!task.task_id) continue;
    const old = byId.get(task.task_id);
    byId.set(task.task_id, {
      ...old,
      ...task,
      status_snapshot: {
        ...(old?.status_snapshot || {}),
        ...(task.status_snapshot || {}),
      },
    });
  }
  return [...byId.values()];
}

export function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function finalResultOf(events: EventRecord[]) {
  const deliveries = events.filter((event) => event.type === "delivery_received");
  if (!deliveries.length) return undefined;
  return deliveries[deliveries.length - 1];
}

export function formatTime(value?: string, mode: "datetime" | "time" = "datetime") {
  if (!value) return "";
  const date = new Date(value);
  return mode === "time" ? date.toLocaleTimeString() : date.toLocaleString();
}

export function snapshotStatus(task?: Task) {
  return task?.status_snapshot?.status || task?.status || "received";
}
