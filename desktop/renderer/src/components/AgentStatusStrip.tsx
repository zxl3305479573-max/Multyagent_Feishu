import type { AgentCard } from "../types";
import { eventLabels, statusLabels } from "../labels";
import { formatDuration } from "../format";

type Props = { cards: AgentCard[]; selectedAgent: string; onSelect: (agentKey: string) => void };

export function AgentStatusStrip({ cards, selectedAgent, onSelect }: Props) {
  if (!cards.length) return null;
  return (
    <section className="central-agent-status" aria-label="Agent 状态">
      <div className="central-agent-status-heading"><span>Agent 状态</span><span>{cards.length} 个 Agent</span></div>
      <div className="central-agent-status-list">
        {cards.map(({ agent, status, latest, taskCount, durationMs }) => <button key={agent.key} className={`agent-card ${selectedAgent === agent.key ? "is-selected" : ""}`} onClick={() => onSelect(agent.key)} title={`${agent.displayName || agent.key} · 观察`}>
          <span className={`agent-card-dot agent-card-${status}`} />
          <span className="agent-card-body">
            <span className="agent-card-title"><strong>{agent.displayName || agent.key}</strong><span>{statusLabels[status] || status}</span></span>
            <span className="agent-card-recent">{latest?.summary || eventLabels[latest?.type || ""] || "暂无结构化事件"}</span>
            <span className="agent-card-meta">{formatDuration(durationMs)}{taskCount ? ` · ${taskCount} 个任务` : ""}</span>
          </span>
          <span className="agent-card-open">观察</span>
        </button>)}
      </div>
    </section>
  );
}
