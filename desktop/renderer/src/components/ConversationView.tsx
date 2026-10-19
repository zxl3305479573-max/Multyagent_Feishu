import React from "react";
import type { Agent, AgentExecutionGroup, EventRecord, Task } from "../types";
import { eventLabels, statusLabels } from "../labels";
import { formatDuration, formatFileSize, formatTime, snapshotStatus, taskStatus } from "../format";
import { collectArtifacts, toolExecutionStatus } from "../execution-view";

type OpenFile = (event: EventRecord) => void;

function Artifacts({ event, onOpenFile }: { event: EventRecord; onOpenFile: OpenFile }) {
  return <div className="delivery-artifacts"><strong>交付文件</strong>{collectArtifacts(event).map((artifact) => <div className="delivery-artifact" key={artifact.path}>
    <a href="#open-file" onClick={(clickEvent) => { clickEvent.preventDefault(); onOpenFile({ ...event, file_path: artifact.path }); }} title="打开交付文件">{artifact.path}</a>
    <span>{artifact.description}</span><small>{artifact.type || "文件"}{artifact.size !== undefined ? ` · ${formatFileSize(artifact.size)}` : ""}</small>
  </div>)}</div>;
}

function ExecutionEvent({ event, agents, onOpenFile }: { event: EventRecord; agents: Agent[]; onOpenFile: OpenFile }) {
  const summary = event.summary || eventLabels[event.type || ""] || "任务状态已更新";
  const isError = event.status === "failed" || event.type?.includes("failed") || event.type === "error";
  return <article className={`message agent-message agent-execution-event ${isError ? "message-error" : ""}`}>
    <div className="message-body">
      <div className="message-author">{eventLabels[event.type || ""] || event.type || "事件"}<time>{formatTime(event.timestamp)}</time></div>
      <p>{summary}</p>
      {(event.target || event.tool) && <div className="message-tags">{event.target && <span>分配给 {agents.find((agent) => agent.key === event.target)?.displayName || event.target}</span>}{event.tool && <span>工具 · {event.tool}</span>}</div>}
      {event.command && <pre className="event-code">{event.command}</pre>}
      {event.file_path && <p className="event-path">文件：<a href="#open-file" onClick={(clickEvent) => { clickEvent.preventDefault(); onOpenFile(event); }} title="打开对应文件">{event.file_path}</a></p>}
      {event.error && <p className="event-error">{event.error}</p>}
      {typeof event.artifact_count === "number" && event.artifact_count > 0 && <p className="event-artifacts">交付了 {event.artifact_count} 个文件</p>}
      {event.type === "delivery_received" && collectArtifacts(event).length ? <Artifacts event={event} onOpenFile={onOpenFile} /> : null}
      {event.targets?.length ? <div className="message-tags">{event.targets.map((target) => <span key={target}>派给 {agents.find((agent) => agent.key === target)?.displayName || target}</span>)}</div> : null}
    </div>
  </article>;
}

function FinalResult({ group, onOpenFile }: { group: AgentExecutionGroup; onOpenFile: OpenFile }) {
  const result = group.finalResult;
  if (!result) {
    return <div className="agent-final-pending">{group.status === "failed" ? "本轮执行失败，未产生有效交付。" : group.status === "cancelled" ? "本轮执行已终止。" : group.status === "completed" ? "本轮执行已结束，未记录交付内容。" : "等待该 Agent 提交最终结果。"}</div>;
  }
  return <div className="agent-final-result">
    <div className="agent-final-result-heading"><strong>最终执行结果</strong><time>{formatTime(result.timestamp)}</time></div>
    <p>{result.summary || "已完成本轮工作"}</p>
    {(result.blockers?.length || result.risks?.length || result.next) ? <div className="agent-final-fields">
      {result.next && <div><strong>下一步</strong><span>{result.next}</span></div>}
      {result.blockers?.length ? <div><strong>阻塞</strong><span>{result.blockers.join("；")}</span></div> : null}
      {result.risks?.length ? <div><strong>风险</strong><span>{result.risks.join("；")}</span></div> : null}
    </div> : null}
    {collectArtifacts(result).length ? <Artifacts event={result} onOpenFile={onOpenFile} /> : null}
  </div>;
}

function ExecutionGroup({ group, agents, focused, sectionRef, onOpenFile }: { group: AgentExecutionGroup; agents: Agent[]; focused: boolean; sectionRef: (element: HTMLElement | null) => void; onOpenFile: OpenFile }) {
  return <section className={`agent-execution-group ${focused ? "is-focused" : ""}`} ref={sectionRef}>
    <header className="agent-execution-overview">
      <span className="message-avatar agent-avatar">{group.displayName.slice(0, 1)}</span>
      <div className="agent-execution-overview-copy">
        <div className="agent-execution-overview-title"><strong>{group.displayName}</strong><span className={`agent-execution-status status-${group.status}`}>{statusLabels[group.status] || group.status}</span></div>
        {group.assignedTask && <p>{group.assignedTask}</p>}
        <div className="agent-execution-meta">
          <span>{group.startedAt ? `开始 ${formatTime(group.startedAt, "time")}` : "未记录开始时间"}</span>
          <span>{group.endedAt ? `结束 ${formatTime(group.endedAt, "time")}` : group.status === "running" ? "执行中" : "无结束记录"}</span>
          <span>耗时 {formatDuration(group.durationMs)}</span>
          <span>{group.toolCount} 次工具</span>
          <span>{group.fileCount} 个文件</span>
          <span className={group.testFailed ? "meta-failed" : ""}>{group.testCount ? `${group.testCount} 次测试${group.testFailed ? " · 有失败" : ""}` : "无测试事件"}</span>
        </div>
      </div>
    </header>
    <details className="agent-execution-process">
      <summary><span className="agent-execution-chevron">›</span><span>执行过程 · {group.items.length} 项</span></summary>
      <div className="agent-execution-events">{group.items.map((item, index) => item.kind === "event"
        ? <ExecutionEvent key={item.event.event_id || `${item.event.type}-${index}`} event={item.event} agents={agents} onOpenFile={onOpenFile} />
        : <details className={`tool-execution tool-${toolExecutionStatus(item.execution.events)}`} key={`tool-${item.execution.events[0]?.event_id || index}`}>
          <summary><span className="tool-execution-chevron">›</span><span className="tool-execution-title">{item.execution.tool}</span><span className="tool-execution-status">{statusLabels[toolExecutionStatus(item.execution.events)] || toolExecutionStatus(item.execution.events)}</span><span className="tool-execution-count">{item.execution.events.length} 个步骤</span></summary>
          <div className="tool-execution-content">{item.execution.events.map((event, eventIndex) => <ExecutionEvent key={event.event_id || `${event.type}-${eventIndex}`} event={event} agents={agents} onOpenFile={onOpenFile} />)}</div>
        </details>)}</div>
    </details>
    <FinalResult group={group} onOpenFile={onOpenFile} />
  </section>;
}

type ConversationProps = {
  selected: string;
  selectedTask?: Task;
  project: string;
  agents: Agent[];
  selectedAgent: string;
  taskEvents: EventRecord[];
  taskEventsLoading: boolean;
  groups: AgentExecutionGroup[];
  taskStartedAt?: string;
  taskDuration: number | null;
  sectionRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  onOpenFile: OpenFile;
};

export function ConversationView({ selected, selectedTask, project, agents, selectedAgent, taskEvents, taskEventsLoading, groups, taskStartedAt, taskDuration, sectionRefs, onOpenFile }: ConversationProps) {
  return <div className="conversation-scroll" key={selected || "empty"}>
    {!selectedTask ? (
      <div className="welcome-state">
        <span className="welcome-mark">A</span>
        <h2>接下来要完成什么？</h2>
        <p>描述目标和约束，项目经理会规划任务并分配给合适的 Agent。</p>
        <div className="welcome-chips"><span>按项目隔离上下文</span><span>并行执行独立任务</span><span>随时观察与控制</span></div>
      </div>
    ) : (
      <div className="conversation-content">
        <div className="conversation-task-overview"><strong>{selectedTask.title || "当前任务"}</strong><span>{selectedTask.project_name || project} · {taskStatus(selectedTask)}{taskStartedAt ? ` · 开始 ${formatTime(taskStartedAt)} · 总耗时 ${formatDuration(taskDuration)}` : ""}</span></div>
        {taskEvents.length === 0 && (taskEventsLoading
          ? <div className="conversation-empty"><span className="empty-spinner" />正在加载任务记录…</div>
          : <div className="conversation-empty">暂无任务记录</div>)}
        {taskEvents.filter((event) => event.type === "task_created").map((event, index) => <article className="message user-message" key={event.event_id || `request-${index}`}><div className="message-avatar user-avatar">你</div><div className="message-body"><div className="message-author">你 <time>{formatTime(event.timestamp)}</time></div><p>{selectedTask.description || event.text || selectedTask.title}</p></div></article>)}
        {groups.map((group) => <ExecutionGroup key={group.key} group={group} agents={agents} focused={selectedAgent === group.key} sectionRef={(element) => { sectionRefs.current[group.key] = element; }} onOpenFile={onOpenFile} />)}
        {["running", "in_progress"].includes(snapshotStatus(selectedTask)) && <div className="running-indicator"><span className="pulse-dot" />Agent 正在执行</div>}
      </div>
    )}
  </div>;
}

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  hasTask: boolean;
  canSubmit: boolean;
};

export function Composer({ value, onChange, onSubmit, hasTask, canSubmit }: ComposerProps) {
  return <div className="composer-wrap">
    <form className="composer" onSubmit={onSubmit}>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={hasTask ? "继续描述下一个任务…" : "描述你想完成的任务…"} rows={3} aria-label="任务描述" />
      <div className="composer-send-row"><button className="send-button" type="submit" disabled={!canSubmit} aria-label="提交任务" title="提交新任务">↑</button></div>
    </form>
  </div>;
}
