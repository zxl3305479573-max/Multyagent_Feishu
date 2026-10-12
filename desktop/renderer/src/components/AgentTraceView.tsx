import type { Agent, EventRecord } from "../types";
import { eventLabels } from "../labels";
import { formatTime } from "../format";

type Props = {
  agents: Agent[];
  selectedAgent: string;
  taskTitle?: string;
  events: EventRecord[];
  onOpenFile: (event: EventRecord) => void;
};

export function AgentTraceView({ agents, selectedAgent, taskTitle, events, onOpenFile }: Props) {
  const agentName = agents.find((agent) => agent.key === selectedAgent)?.displayName || selectedAgent;
  const scope = [agentName || (taskTitle ? "全部 Agent" : ""), taskTitle].filter(Boolean).join(" · ");
  return (
    <div className="conversation-scroll central-trace-scroll">
      <div className="central-view inspector-content">
        <div className="task-controls"><div><strong>Agent 时间线</strong><span>{scope || "选择一个 Agent 查看事件"}</span></div></div>
        <div className="trace-heading"><h3>结构化事件</h3><span>{events.length} 条记录</span></div>
        {events.map((event, index) => <div className="trace-row" key={event.event_id || `trace-${index}`}>
          <span className={`trace-dot ${event.status === "failed" ? "trace-failed" : ""}`} />
          <div>
            <strong>{eventLabels[event.type || ""] || event.type || "事件"}</strong>
            <p>{event.agent || event.target || "系统"}{event.tool ? ` · ${event.tool}` : ""}</p>
            {event.summary && <small>{event.summary}</small>}
            {event.file_path && <small className="trace-file">文件：<a href="#open-file" onClick={(clickEvent) => { clickEvent.preventDefault(); onOpenFile(event); }} title="打开对应文件">{event.file_path}</a></small>}
            {event.error && <small className="event-error">{event.error}</small>}
            <time>{formatTime(event.timestamp, "time")}</time>
          </div>
        </div>)}
      </div>
    </div>
  );
}
