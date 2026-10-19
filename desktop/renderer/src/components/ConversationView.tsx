import React from "react";
import type { Agent, AgentExecutionGroup, AgentExecutionItem, EventRecord, Task } from "../types";
import { eventLabels, statusLabels, verdictLabels } from "../labels";
import { formatDuration, formatFileSize, formatTime, snapshotStatus, taskStatus } from "../format";
import { collectArtifacts, toolExecutionStatus } from "../execution-view";
import { RuntimeModelPicker } from "./RuntimeModelPicker";
import { ModeBar } from "./ModeBar";
import type { RuntimeConfig, TaskModes } from "../types";

// 规划模式下等待确认的内容：最近一条 approval_required 之后还没有派发、结算或失败等后续事件。
const SETTLING_AFTER_APPROVAL = new Set(["dispatch_started", "task_settle", "task_failed", "task_terminated", "task_cancelled", "selection_failed", "control_applied"]);
export function pendingApproval(taskEvents: EventRecord[]) {
  let index = -1;
  taskEvents.forEach((event, position) => { if (event.type === "approval_required") index = position; });
  if (index < 0) return null;
  if (taskEvents.slice(index + 1).some((event) => SETTLING_AFTER_APPROVAL.has(event.type || ""))) return null;
  const approval = taskEvents[index];
  const delivery = [...taskEvents.slice(0, index + 1)].reverse().find((event) => event.type === "delivery_received" && event.task_id === approval.task_id);
  return { taskId: approval.task_id || "", agent: approval.agent || "", summary: delivery?.summary || "", next: delivery?.next || "" };
}

type OpenFile = (event: EventRecord) => void;

function Artifacts({ event, onOpenFile }: { event: EventRecord; onOpenFile: OpenFile }) {
  const artifacts = collectArtifacts(event);
  const totalSize = artifacts.reduce((sum, artifact) => sum + (typeof artifact.size === "number" ? artifact.size : 0), 0);
  return <details className="delivery-artifacts">
    <summary>
      <span className="delivery-artifacts-title"><strong>交付文件</strong><small>{artifacts.length} 个{totalSize ? ` · ${formatFileSize(totalSize)}` : ""}</small></span>
      <span className="delivery-artifacts-chevron">›</span>
    </summary>
    <div className="delivery-artifact-list">{artifacts.map((artifact) => <div className="delivery-artifact" key={artifact.path}>
      <a href="#open-file" onClick={(clickEvent) => { clickEvent.preventDefault(); onOpenFile({ ...event, file_path: artifact.path }); }} title="打开交付文件">{artifact.path}</a>
      <span>{artifact.description}</span><small>{artifact.type || "文件"}{artifact.size !== undefined ? ` · ${formatFileSize(artifact.size)}` : ""}</small>
    </div>)}</div>
  </details>;
}

// 测试的结构化验收：结论、逐项检查和证据，失败项一眼可见。
function Acceptance({ event, onOpenFile }: { event: EventRecord; onOpenFile: OpenFile }) {
  return <div className={`acceptance-card verdict-${event.verdict}`}>
    <div className="acceptance-heading"><strong>验收结论：{verdictLabels[event.verdict || ""] || event.verdict}</strong>{event.skip_reason && <span>{event.skip_reason}</span>}</div>
    {event.checks?.length ? <ul className="acceptance-checks">{event.checks.map((check, index) => <li key={check.id || index} className={`check-${check.status}`}>
      <span className="check-status">{verdictLabels[check.status || ""] || check.status}</span><span>{check.id ? `${check.id} ` : ""}{check.title}</span>{check.detail && <small>{check.detail}</small>}
    </li>)}</ul> : null}
    {event.evidence?.length ? <div className="acceptance-evidence"><strong>证据</strong>{event.evidence.map((item, index) => <div key={index}>
      <span>{item.kind}</span>
      {item.path ? <a href="#open-file" onClick={(clickEvent) => { clickEvent.preventDefault(); onOpenFile({ ...event, file_path: item.path }); }}>{item.path}</a> : item.url ? <span>{item.url}</span> : <span>{item.text}</span>}
    </div>)}</div> : null}
  </div>;
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
      {event.type === "acceptance_submitted" ? <Acceptance event={event} onOpenFile={onOpenFile} /> : null}
      {event.failed_checks?.length && event.type !== "acceptance_submitted" ? <p className="event-error">未通过：{event.failed_checks.join("；")}</p> : null}
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

type ToolExecutionData = Extract<AgentExecutionItem, { kind: "tool" }>["execution"];
type ExecutionBlock = { kind: "event"; event: EventRecord } | { kind: "tools"; executions: ToolExecutionData[] };

// 连续的工具调用合并成一个可折叠块，避免过程里一长串工具卡片。
function groupExecutionItems(items: AgentExecutionItem[]): ExecutionBlock[] {
  const blocks: ExecutionBlock[] = [];
  for (const item of items) {
    if (item.kind === "event") { blocks.push(item); continue; }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "tools") last.executions.push(item.execution);
    else blocks.push({ kind: "tools", executions: [item.execution] });
  }
  return blocks;
}

function ToolRun({ executions, agents, onOpenFile }: { executions: ToolExecutionData[]; agents: Agent[]; onOpenFile: OpenFile }) {
  const statuses = executions.map((execution) => toolExecutionStatus(execution.events));
  const runStatus = statuses.includes("failed") ? "failed" : statuses.includes("running") ? "running" : "completed";
  const failedCount = statuses.filter((status) => status === "failed").length;
  const names = [...new Set(executions.map((execution) => execution.tool))];
  return <details className={`tool-run tool-run-${runStatus}`}>
    <summary><span className="tool-run-chevron">›</span><span className="tool-run-title">工具调用 · {executions.length} 次</span><span className="tool-run-names">{names.join("、")}</span><span className="tool-run-status">{runStatus === "failed" ? `${failedCount} 次失败` : statusLabels[runStatus] || runStatus}</span></summary>
    <div className="tool-run-content">{executions.map((execution, index) => {
      const status = toolExecutionStatus(execution.events);
      return <details className={`tool-execution tool-${status}`} key={`tool-${execution.events[0]?.event_id || index}`}>
        <summary><span className="tool-execution-chevron">›</span><span className="tool-execution-title">{execution.tool}</span><span className="tool-execution-status">{statusLabels[status] || status}</span><span className="tool-execution-count">{execution.events.length} 个步骤</span></summary>
        <div className="tool-execution-content">{execution.events.map((event, eventIndex) => <ExecutionEvent key={event.event_id || `${event.type}-${eventIndex}`} event={event} agents={agents} onOpenFile={onOpenFile} />)}</div>
      </details>;
    })}</div>
  </details>;
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
      <div className="agent-execution-events">{groupExecutionItems(group.items).map((block, index) => block.kind === "event"
        ? <ExecutionEvent key={block.event.event_id || `${block.event.type}-${index}`} event={block.event} agents={agents} onOpenFile={onOpenFile} />
        : <ToolRun key={`run-${block.executions[0]?.events[0]?.event_id || index}`} executions={block.executions} agents={agents} onOpenFile={onOpenFile} />)}</div>
    </details>
    <FinalResult group={group} onOpenFile={onOpenFile} />
  </section>;
}

type ConversationProps = {
  selected: string;
  selectedTask?: Task;
  project: string;
  agents: Agent[];
  userDisplayName: string;
  selectedAgent: string;
  taskEvents: EventRecord[];
  taskEventsLoading: boolean;
  groups: AgentExecutionGroup[];
  taskStartedAt?: string;
  taskDuration: number | null;
  sectionRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  onOpenFile: OpenFile;
  approving?: boolean;
  onApprove?: (taskId: string) => void;
};

export function ConversationView({ selected, selectedTask, project, agents, userDisplayName, selectedAgent, taskEvents, taskEventsLoading, groups, taskStartedAt, taskDuration, sectionRefs, onOpenFile, approving = false, onApprove }: ConversationProps) {
  const userName = userDisplayName.trim() || "我";
  const userInitial = Array.from(userName)[0] || "我";
  const approval = selectedTask && onApprove ? pendingApproval(taskEvents) : null;
  const approverName = approval ? agents.find((agent) => agent.key === approval.agent)?.displayName || approval.agent : "";
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
        {approval && <div className="approval-banner" role="status">
          <div><strong>{approverName} 的方案等待你确认</strong><span>{approval.next || approval.summary.slice(0, 160) || "确认后开始执行"}</span></div>
          <button type="button" disabled={approving} onClick={() => onApprove?.(approval.taskId)}>{approving ? "确认中…" : "确认执行"}</button>
        </div>}
        <div className="conversation-task-overview"><strong>{selectedTask.title || "当前任务"}</strong><span>{selectedTask.project_name || project} · {taskStatus(selectedTask)}{taskStartedAt ? ` · 开始 ${formatTime(taskStartedAt)} · 总耗时 ${formatDuration(taskDuration)}` : ""}</span></div>
        {taskEvents.length === 0 && (taskEventsLoading
          ? <div className="conversation-empty"><span className="empty-spinner" />正在加载任务记录…</div>
          : <div className="conversation-empty">暂无任务记录</div>)}
        {taskEvents.filter((event) => ["task_created", "task_reused"].includes(event.type || "")).map((event, index) => <article className="message user-message" key={event.event_id || `request-${index}`}><div className="message-avatar user-avatar" title={userName} aria-label={userName}>{userInitial}</div><div className="message-body"><div className="message-author"><time>{formatTime(event.timestamp)}</time></div><p>{event.type === "task_reused" ? event.text || "继续当前任务" : selectedTask.description || event.text || selectedTask.title}</p></div></article>)}
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
  runtimeConnected: boolean;
  runtimeConfig: RuntimeConfig | null;
  runtimeBusy: boolean;
  onLoadProvider: (provider: string) => Promise<RuntimeConfig>;
  onRuntimeChange: (input: { provider: string; model: string; thinking: string }) => void;
  onThinkingChange: (thinking: string) => void;
  modes: TaskModes;
  modeAgents: Agent[];
  lockTarget?: string | null;
  onModesChange: (modes: TaskModes) => void;
};

export function Composer({ value, onChange, onSubmit, hasTask, canSubmit, runtimeConnected, runtimeConfig, runtimeBusy, onLoadProvider, onRuntimeChange, onThinkingChange, modes, modeAgents, lockTarget = null, onModesChange }: ComposerProps) {
  return <div className="composer-wrap">
    <form className="composer" onSubmit={onSubmit}>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={hasTask ? "继续当前任务…" : "描述你想完成的任务…"} rows={3} aria-label="任务描述" />
      <div className="composer-send-row">
        <ModeBar value={modes} agents={modeAgents} lockTarget={lockTarget} disabled={!runtimeConnected} onChange={onModesChange} />
        <RuntimeModelPicker config={runtimeConfig} connected={runtimeConnected} busy={runtimeBusy} onLoadProvider={onLoadProvider} onSelect={onRuntimeChange} onThinking={onThinkingChange} />
        <button className="send-button" type="submit" disabled={!canSubmit} aria-label={hasTask ? "发送后续消息" : "提交任务"} data-tooltip={hasTask ? "发送到当前任务；保留同一任务和对话记忆。" : "创建一个新任务并开始执行。"}>↑</button>
      </div>
    </form>
  </div>;
}
