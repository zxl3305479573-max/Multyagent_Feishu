import { useCallback, useEffect, useState } from "react";
import type { EventRecord, GatewayStatus, RuntimeConfig, Task } from "../types";
import { eventTime, snapshotStatus, taskStatus } from "../format";
import { eventLabels } from "../labels";
import { StatusMood } from "./AgentVisuals";
import { taskStatusToken } from "../themes/task-status";

type Props = {
  tasks: Task[];
  events: EventRecord[];
  project: string;
  connection: string;
  runtimeConfig: RuntimeConfig | null;
  onOpenSettings: () => void;
};

function uptimeLabel(startedAt: string | null) {
  const started = Date.parse(startedAt || "");
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`;
}

export function RuntimeMonitorView({ tasks, events, project, connection, runtimeConfig, onOpenSettings }: Props) {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    if (!window.desktop?.gatewayStatus) {
      setGateway(null);
      setCheckedAt(new Date());
      return;
    }
    setLoading(true);
    try {
      setGateway(await window.desktop.gatewayStatus());
    } finally {
      setLoading(false);
      setCheckedAt(new Date());
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const statusCounts = tasks.reduce<Record<string, number>>((result, task) => {
    const token = taskStatusToken(snapshotStatus(task));
    result[token] = (result[token] || 0) + 1;
    return result;
  }, {});
  const errors = events
    .filter((event) => event.type === "task_failed" || event.type === "error" || event.status === "failed")
    .sort((left, right) => eventTime(right) - eventTime(left))
    .slice(0, 8);
  const recent = [...events].sort((left, right) => eventTime(right) - eventTime(left)).slice(0, 10);

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>网关与任务运行状态</span><h2>运行监控</h2><p>展示 Electron 主进程健康检查、当前模型、任务状态分布和最近事件。当前版本不采集 CPU、内存、Token 用量或持久化指标。</p></div>
      <dl><div><dt>连接</dt><dd className={`feature-status ${connection === "已连接" ? "is-ok" : "is-warn"}`}>{connection}</dd></div><div><dt>事件窗口</dt><dd>{events.length}</dd></div></dl>
    </section>
    <div className="feature-toolbar">
      <span className="feature-toolbar-note">{checkedAt ? `最近检查 ${checkedAt.toLocaleTimeString()}` : "等待首次检查"}</span>
      <button className="quiet-button" onClick={() => void refresh()} disabled={loading}>{loading ? "检查中…" : "重新检查"}</button>
    </div>

    <div className="monitor-metric-grid">
      <article><span>网关进程</span><strong>{gateway?.running ? "运行中" : connection === "已连接" ? "已连接" : "未运行"}</strong><small>{gateway?.pid ? `PID ${gateway.pid}` : "浏览器预览或未启动"}</small></article>
      <article><span>健康检查</span><strong className={gateway?.healthy ? "metric-ok" : "metric-warn"}>{gateway?.healthy ? "正常" : "不可用"}</strong><small>{gateway?.port ? `127.0.0.1:${gateway.port}` : gateway?.error || "无端口信息"}</small></article>
      <article><span>运行时长</span><strong>{uptimeLabel(gateway?.startedAt || null)}</strong><small>{gateway?.startedAt ? new Date(gateway.startedAt).toLocaleString() : "无启动时间"}</small></article>
      <article><span>当前模型</span><strong>{runtimeConfig ? runtimeConfig.model : "未读取"}</strong><small>{runtimeConfig ? `${runtimeConfig.provider} · ${runtimeConfig.thinking}` : "打开运行设置查看模型"}</small></article>
    </div>

    <section className="monitor-section">
      <header><h3>任务状态分布</h3><span>{project || "全部项目"} · {tasks.length} 个任务</span></header>
      <div className="monitor-status-grid">{(["running", "waiting-approval", "completed", "failed", "cancelled", "pending"] as const).map((status) => <div key={status}>
        <StatusMood status={status} label={status} />
        <span>{status === "running" ? "执行中" : status === "waiting-approval" ? "等待确认" : status === "completed" ? "已完成" : status === "failed" ? "失败" : status === "cancelled" ? "已终止" : "待处理"}</span>
        <strong>{statusCounts[status] || 0}</strong>
      </div>)}</div>
    </section>

    <div className="monitor-columns">
      <section className="monitor-section">
        <header><h3>最近异常</h3><span>{errors.length} 条</span></header>
        {!errors.length && <div className="feature-empty compact"><strong>当前窗口内没有异常</strong><span>只展示本次连接收到的事件。</span></div>}
        <div className="monitor-event-list">{errors.map((event) => <article key={event.event_id || `${event.type}-${event.timestamp}`} className="monitor-event monitor-event-error">
          <strong>{eventLabels[event.type || ""] || event.type}</strong>
          <span>{event.error || event.summary || "未提供错误详情"}</span>
          <small>{event.task_id || "未知任务"} · {event.timestamp ? new Date(event.timestamp).toLocaleString() : "无时间"}</small>
        </article>)}</div>
      </section>
      <section className="monitor-section">
        <header><h3>最近事件</h3><span>最近 10 条</span></header>
        {!recent.length && <div className="feature-empty compact"><strong>暂无运行事件</strong><span>创建任务后事件会实时进入这里。</span></div>}
        <div className="monitor-event-list">{recent.map((event) => <article key={event.event_id || `${event.type}-${event.timestamp}`} className="monitor-event">
          <strong>{eventLabels[event.type || ""] || event.type || "事件"}</strong>
          <span>{event.summary || event.text || event.tool || "—"}</span>
          <small>{event.task_id || "—"} · {event.timestamp ? new Date(event.timestamp).toLocaleString() : "无时间"}</small>
        </article>)}</div>
      </section>
    </div>
    <div className="monitor-footer"><span>任务状态来自 `TaskStore`，事件来自桌面 WebSocket；健康检查来自 `desktop:gateway:status`。</span><button className="link-button" onClick={onOpenSettings}>打开运行设置</button></div>
  </div>;
}
