import { useMemo } from "react";
import type { AgentCard, EventRecord } from "../types";
import { eventLabels, statusLabels } from "../labels";
import { formatDuration } from "../format";
import { latestPlanProgress } from "../execution-view";

type Props = { cards: AgentCard[]; selectedAgent: string; onSelect: (agentKey: string) => void; events?: EventRecord[] };

const SLICE_STATUS: Record<string, string> = { pending: "待执行", running: "执行中", completed: "已完成", failed: "失败", interrupted: "已中断" };

// 标题栏右侧的紧凑状态条：一字排开显示各 Agent 的状态，详情放在悬停提示里。
// 任务拆成多个切片时，最前面多一枚“切片 x/y”，悬停可看每一片的状态。
export function AgentStatusStrip({ cards, selectedAgent, onSelect, events = [] }: Props) {
  const plan = useMemo(() => latestPlanProgress(events), [events]);
  if (!cards.length) return null;
  const planStatus = plan ? (plan.failed ? "failed" : plan.running ? "running" : plan.completed === plan.total ? "completed" : "waiting") : "";
  return (
    <nav className="header-agent-status" aria-label="Agent 状态">
      {plan && <span
        className="agent-chip"
        role="status"
        title={plan.slices.map((slice) => `${SLICE_STATUS[slice.status] || slice.status} · ${slice.id}（${slice.agent}）${slice.title ? `：${slice.title}` : ""}`).join("\n")}
      >
        <span className={`agent-card-dot agent-card-${planStatus}`} />
        <strong>切片</strong>
        <span className="agent-chip-status">{plan.completed}/{plan.total}{plan.running ? ` · ${plan.running} 进行中` : ""}{plan.failed ? ` · ${plan.failed} 失败` : ""}</span>
      </span>}
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
