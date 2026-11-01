import { useMemo, useState } from "react";
import type { Task } from "../types";
import { snapshotStatus, taskStatus } from "../format";
import { StatusMood } from "./AgentVisuals";
import { taskStatusToken } from "../themes/task-status";

type Props = { tasks: Task[]; project: string; onOpenTask: (taskId: string) => void };

export function TaskHistoryView({ tasks, project, onOpenTask }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const sorted = useMemo(() => [...tasks].sort((left, right) => Date.parse(right.updated_at || right.created_at || "") - Date.parse(left.updated_at || left.created_at || "")), [tasks]);
  const needle = query.trim().toLowerCase();
  const visible = sorted.filter((task) => {
    const token = taskStatusToken(snapshotStatus(task));
    return (status === "all" || token === status)
      && (!needle || `${task.title || ""} ${task.description || ""} ${task.project_name || ""} ${task.task_id || ""}`.toLowerCase().includes(needle));
  });
  const counts = sorted.reduce<Record<string, number>>((result, task) => {
    const token = taskStatusToken(snapshotStatus(task));
    result[token] = (result[token] || 0) + 1;
    return result;
  }, {});

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>持久化任务记录</span><h2>任务历史</h2><p>浏览当前项目作用域内的全部任务，并回到任意任务查看完整执行时间线。归档与导出仍由项目上下文页负责。</p></div>
      <dl><div><dt>当前项目</dt><dd className="feature-text-value">{project || "全部项目"}</dd></div><div><dt>任务总数</dt><dd>{sorted.length}</dd></div></dl>
    </section>
    <div className="feature-toolbar feature-toolbar-wrap">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、描述、项目或任务编号" aria-label="搜索任务历史" />
      <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="筛选任务状态">
        <option value="all">全部状态（{sorted.length}）</option>
        <option value="running">执行中（{counts.running || 0}）</option>
        <option value="waiting-approval">等待确认（{counts["waiting-approval"] || 0}）</option>
        <option value="completed">已完成（{counts.completed || 0}）</option>
        <option value="failed">失败（{counts.failed || 0}）</option>
        <option value="cancelled">已终止（{counts.cancelled || 0}）</option>
        <option value="pending">待处理（{counts.pending || 0}）</option>
      </select>
    </div>
    {!visible.length && <div className="feature-empty"><strong>{sorted.length ? "没有匹配的任务" : "还没有任务记录"}</strong><span>{sorted.length ? "调整搜索或状态筛选后再试。" : "从首页创建任务后，任务历史会保存在本地任务库。"}</span></div>}
    {visible.length > 0 && <div className="history-list">{visible.map((task) => <button className="history-row" key={task.task_id} onClick={() => onOpenTask(task.task_id || "")}>
      <StatusMood status={snapshotStatus(task)} label={taskStatus(task)} />
      <span className="history-row-main">
        <strong>{task.title || task.task_id || "未命名任务"}</strong>
        <span>{task.description || "无任务描述"}</span>
        <small>{task.project_name || "未归属项目"} · {task.agent || "未指定 Agent"} · {task.task_id}</small>
      </span>
      <span className={`status-chip status-${taskStatusToken(snapshotStatus(task))}`}>{taskStatus(task)}</span>
      <time>{task.updated_at || task.created_at ? new Date(task.updated_at || task.created_at || "").toLocaleString() : "—"}</time>
    </button>)}</div>}
    <p className="feature-note">数据来源：桌面 WebSocket `ready` 快照中的 `tasks`（`TaskStore.list()`），点击任务后按需读取 `task_events`。</p>
  </div>;
}
