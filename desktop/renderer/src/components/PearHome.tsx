import type { ReactNode } from "react";
import type { AgentExecutionGroup, EventRecord, Task } from "../types";
import { snapshotStatus, taskStatus } from "../format";
import { useSkinPack } from "../themes/SkinContext";
import { createSkinAnimationAdapter, moodStateForTaskStatus } from "../themes/animation";
import { taskStatusToken } from "../themes/task-status";

type Props = { selectedTask?: Task; events: EventRecord[]; groups: AgentExecutionGroup[]; onQuickEntry: (prompt: string) => void; children: ReactNode };

export function PearHome({ selectedTask, events, groups, onQuickEntry, children }: Props) {
  const skin = useSkinPack();
  const brand = skin.brand!;
  const status = taskStatusToken(snapshotStatus(selectedTask));
  const toolCalls = groups.reduce((total, group) => total + group.toolCount, 0);
  const toolRobotState = groups.some((group) => group.status === "failed") ? "error"
    : groups.some((group) => ["running", "in_progress"].includes(group.status)) ? "working" : "idle";
  const animation = createSkinAnimationAdapter(skin);
  const toolRobot = skin.id === "pear" ? animation.robot(toolRobotState) : undefined;
  const mood = skin.id === "pear" ? animation.mood(moodStateForTaskStatus(status)) : undefined;
  const logs = events.filter((event) => event.summary || event.text).slice(-4).reverse();
  return <div className="pear-home">
    <section className="pear-home-main" aria-label="Pear Agent 欢迎区">
      <div className="pear-welcome">
        {skin.assets?.welcomeIllustration && <img src={skin.assets.welcomeIllustration} alt="Pear Agent 吉祥物与笔记本" />}
        <div><p>{brand.slogan}</p><h2>{brand.welcomeText}</h2><span>把目标交给 Pear Agent，从思考到交付一路协作。</span></div>
      </div>
      <div className="pear-quick-entries" aria-label="快捷任务入口">{brand.quickEntries?.map((entry) => <button key={entry.id} type="button" onClick={() => onQuickEntry(entry.prompt)}>
        <i aria-hidden="true">{entry.icon}</i><strong>{entry.label}</strong><span>{entry.description}</span>
      </button>)}</div>
      <div className="pear-composer-slot">{children}</div>
    </section>
    {skin.layout?.taskPanel && <aside className="pear-task-panel" aria-label="当前任务进度">
      <header><span>任务面板</span><i className={`pear-status pear-status-${status}`}>{mood && <img className="pear-mood" src={mood} alt="" aria-hidden="true" />}{selectedTask ? taskStatus(selectedTask) : "等待任务"}</i></header>
      <section className="pear-task-section"><h3>当前任务</h3>{selectedTask ? <><strong>{selectedTask.title || "当前任务"}</strong><p>{selectedTask.description || "任务已创建，等待更多执行信息。"}</p></> : <div className="pear-task-empty">{skin.assets?.emptyState && <img src={skin.assets.emptyState} alt="" />}<span>选择快捷入口或描述任务后，这里会开始记录执行进度。</span></div>}</section>
      <section className="pear-task-section"><h3>进度</h3><dl><div><dt>Agent</dt><dd>{groups.length ? `${groups.filter((group) => group.status === "completed").length}/${groups.length} 完成` : "等待开始"}</dd></div><div><dt>状态</dt><dd>{selectedTask ? taskStatus(selectedTask) : "待创建"}</dd></div></dl></section>
      <section className="pear-task-section"><h3>工具调用</h3><div className="pear-task-metric">{toolRobot && <img className="pear-tool-robot" src={toolRobot} alt="" aria-hidden="true" />}<b>{toolCalls}</b><span>次工具调用</span></div></section>
      <section className="pear-task-section pear-task-logs"><h3>日志</h3>{logs.length ? logs.map((event, index) => <p key={event.event_id || index}>{event.summary || event.text}</p>) : <p>尚未收到执行日志</p>}</section>
    </aside>}
  </div>;
}
