import type { AgentExecutionGroup, EventRecord, Task } from "../types";
import { snapshotStatus, taskStatus } from "../format";
import { useSkinPack } from "../themes/SkinContext";
import { taskStatusToken } from "../themes/task-status";
import { StatusMood, ToolRobot } from "./AgentVisuals";
import { buildTaskTimeline, summarizeTaskProgress } from "../task-timeline";

type Props = {
  selectedTask?: Task;
  events: EventRecord[];
  groups: AgentExecutionGroup[];
};

export function TaskPanel({ selectedTask, events, groups }: Props) {
  const skin = useSkinPack();
  const status = taskStatusToken(snapshotStatus(selectedTask));
  const timeline = buildTaskTimeline(events, snapshotStatus(selectedTask));
  const progress = summarizeTaskProgress(events, groups, snapshotStatus(selectedTask));
  const toolCalls = groups.reduce((total, group) => total + group.toolCount, 0);
  const robotState = groups.some((group) => group.status === "failed") ? "error"
    : groups.some((group) => ["running", "in_progress"].includes(group.status)) ? "working" : "idle";
  const logs = events.filter((event) => event.summary || event.text).slice(-4).reverse();
  return <aside className="task-panel" aria-label="当前任务进度">
    <header>
      <span>任务面板</span>
      <i className={`status-chip status-${status}`}>
        <StatusMood status={snapshotStatus(selectedTask)} label={selectedTask ? taskStatus(selectedTask) : "待机"} />
        {selectedTask ? taskStatus(selectedTask) : "等待任务"}
      </i>
    </header>

    <section className="task-panel-section">
      <h3>当前任务</h3>
      {selectedTask ? <>
        <strong>{selectedTask.title || "当前任务"}</strong>
        <p>{selectedTask.description || "任务已创建，等待更多执行信息。"}</p>
      </> : <div className="task-panel-empty">
        {skin.assets.emptyState
          ? <img src={skin.assets.emptyState} alt="" aria-hidden="true" />
          : <span className="neutral-empty-visual" aria-hidden="true">A</span>}
        <span>选择快捷入口或描述任务后，这里会开始记录执行进度。</span>
      </div>}
    </section>

    <section className="task-panel-section">
      <h3>进度</h3>
      <div className="task-progress-heading"><strong>{progress.label}</strong><span>{progress.percent}%</span></div>
      <div className="task-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><i style={{ width: `${progress.percent}%` }} /></div>
      <dl>
        <div><dt>Agent</dt><dd>{groups.length ? `${groups.filter((group) => group.status === "completed").length}/${groups.length} 完成` : "等待开始"}</dd></div>
        <div><dt>状态</dt><dd>{selectedTask ? taskStatus(selectedTask) : "待创建"}</dd></div>
      </dl>
    </section>

    <section className="task-panel-section task-panel-timeline">
      <h3>步骤时间线</h3>
      {timeline.length
        ? <ol>{timeline.map((item) => <li key={item.id} className={`timeline-${item.status}`}>
          <i aria-hidden="true" />
          <div><strong>{item.label}</strong>{item.detail && <span>{item.detail}</span>}</div>
        </li>)}</ol>
        : <p>尚未收到执行步骤</p>}
    </section>

    <section className="task-panel-section">
      <h3>工具调用</h3>
      <div className="task-panel-metric"><ToolRobot state={robotState} /><b>{toolCalls}</b><span>次工具调用</span></div>
    </section>

    <section className="task-panel-section task-panel-logs">
      <h3>日志</h3>
      {logs.length ? logs.map((event, index) => <p key={event.event_id || index}>{event.summary || event.text}</p>) : <p>尚未收到执行日志</p>}
    </section>
  </aside>;
}
