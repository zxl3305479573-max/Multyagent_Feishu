import type { AgentCard } from "../types";
import { eventLabels, statusLabels } from "../labels";
import { formatDuration } from "../format";

type Props = { cards: AgentCard[]; selectedAgent: string; onSelect: (agentKey: string) => void };

// 标题栏右侧的紧凑状态条：一字排开显示各 Agent 的状态，详情放在悬停提示里。
export function AgentStatusStrip({ cards, selectedAgent, onSelect }: Props) {
  if (!cards.length) return null;
  return (
    <nav className="header-agent-status" aria-label="Agent 状态">
      {cards.map(({ agent, status, latest, taskCount, durationMs }) => {
        const name = agent.displayName || agent.key;
        const label = statusLabels[status] || status;
        const recent = latest?.summary || eventLabels[latest?.type || ""] || "暂无结构化事件";
        const meta = `${formatDuration(durationMs)}${taskCount ? ` · ${taskCount} 个任务` : ""}`;
        return <button key={agent.key} className={`agent-chip ${selectedAgent === agent.key ? "is-selected" : ""}`} onClick={() => onSelect(agent.key)} title={`${name} · ${label}\n${recent}\n${meta}`}>
          <span className={`agent-card-dot agent-card-${status}`} />
          <strong>{name}</strong>
          <span className="agent-chip-status">{label}</span>
        </button>;
      })}
    </nav>
  );
}
