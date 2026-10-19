import type { Agent, ControlCommand, Task } from "../types";
import { snapshotStatus, taskStatus } from "../format";

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  project: string;
  projects: string[];
  onSelectProject: (project: string) => void;
  onRefresh: () => void;
  tasks: Task[];
  selected: string;
  selectedTask?: Task;
  onSelectTask: (taskId: string) => void;
  pendingCommand: ControlCommand | null;
  onControl: (command: ControlCommand) => void;
  onObserve: () => void;
  connection: string;
  projectStats: { taskCount: number; eventCount: number };
  onOpenProject: () => void;
  agents: Agent[];
  selectedAgent: string;
  onObserveAgent: (agentKey: string) => void;
  onOpenSettings: () => void;
  onOpenTickets: () => void;
  onNewProject: () => void;
  onNewConversation: () => void;
};

export function connectionClass(connection: string) {
  return connection === "已连接" ? "connected" : connection === "连接失败" ? "failed" : "pending";
}

export function Sidebar(props: Props) {
  const { collapsed, project, projects, tasks, selected, selectedTask, pendingCommand, connection, projectStats, agents, selectedAgent } = props;
  const selectedStatus = snapshotStatus(selectedTask);
  return (
    <aside className="sidebar" aria-label="项目和历史">
      <div className="brand-row"><span className="brand-mark">A</span><span className="brand-name">Agent 工作台</span><button className="icon-button sidebar-collapse" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={props.onToggleCollapsed}>{collapsed ? "›" : "‹"}</button></div>
      <div className="sidebar-create-actions">
        <button className="project-action-button" onClick={props.onNewProject} title="新建项目"><span>＋</span><span className="sidebar-label">新建项目</span></button>
        <button className="project-action-button" onClick={props.onNewConversation} title="新建项目对话"><span>＋</span><span className="sidebar-label">新建项目对话</span></button>
      </div>
      <label className="project-picker"><span className="sidebar-label">当前项目</span><select aria-label="选择项目" value={project} onChange={(event) => props.onSelectProject(event.target.value)}><option value="">全部项目</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="sidebar-section-heading"><span>最近任务</span><button className="icon-button" aria-label="刷新任务" title="刷新任务" onClick={props.onRefresh}>↻</button></div>
      <nav className="task-nav" aria-label="最近任务">
        {tasks.length === 0 ? <div className="sidebar-empty">{project ? "当前项目暂无任务" : "暂无历史任务"}</div> : tasks.map((task) => (
          <button key={task.task_id} className={`nav-task ${task.task_id === selected ? "is-selected" : ""}`} onClick={() => props.onSelectTask(task.task_id || "")} title={task.title || task.task_id || "未命名任务"}>
            <span className="nav-task-icon">{(task.title || task.task_id || "A").slice(0, 1).toUpperCase()}</span><span className="nav-task-title">{task.title || task.task_id || "未命名任务"}</span>
            <span className="nav-task-meta"><span>{task.project_name || "未归属项目"}</span><span className={`status-dot status-${snapshotStatus(task)}`} />{taskStatus(task)}</span>
          </button>
        ))}
      </nav>
      {selectedTask && <div className="sidebar-task-actions">
        <div className="sidebar-task-actions-heading"><span>当前任务</span><span className={`task-state state-${selectedStatus}`}><i />{taskStatus(selectedTask)}</span></div>
        <div className="sidebar-task-actions-buttons">
          <button onClick={() => props.onControl("pause")} disabled={pendingCommand !== null || ["paused", "cancelled", "completed", "failed"].includes(selectedStatus)}>{pendingCommand === "pause" ? "处理中…" : "暂停"}</button>
          <button onClick={() => props.onControl("resume")} disabled={pendingCommand !== null || selectedTask.status_snapshot?.status !== "paused"}>{pendingCommand === "resume" ? "处理中…" : "继续"}</button>
          {selectedStatus === "failed" && <button onClick={() => props.onControl("retry")} disabled={pendingCommand !== null}>{pendingCommand === "retry" ? "重试中…" : "重试"}</button>}
          <button className="sidebar-terminate" onClick={() => props.onControl("terminate")} disabled={pendingCommand !== null || ["cancelled", "completed", "failed"].includes(selectedStatus)}>{pendingCommand === "terminate" ? "终止中…" : "终止"}</button>
        </div>
        <button className="sidebar-observe-button" onClick={props.onObserve}>打开执行观察</button>
      </div>}
      <div className="sidebar-bottom">
        <div className={`connection-line ${connectionClass(connection)}`}><span className="connection-dot" />{connection}</div>
        {project && <button className="project-context-strip" onClick={props.onOpenProject} aria-label="打开项目上下文" title="项目上下文"><span className="project-context-icon">⌂</span><span className="project-context-details"><span className="project-context-title"><strong>{project}</strong><span>当前项目</span></span><span className="project-context-meta"><span>{projectStats.taskCount} 个任务</span><span>{projectStats.eventCount} 条事件</span></span><span className="project-context-isolated">上下文已隔离 · 管理项目</span></span></button>}
        {agents.length > 0 && <div className="agent-nav-block"><div className="sidebar-section-heading"><span>Agent</span></div>{agents.filter((agent) => agent.enabled !== false).map((agent) => <button key={agent.key} className={`agent-nav ${selectedAgent === agent.key ? "is-selected" : ""}`} onClick={() => props.onObserveAgent(agent.key)} title={`${agent.displayName || agent.key} · 观察`}>{agent.displayName || agent.key}<span>观察</span></button>)}</div>}
        <button className="settings-nav" onClick={props.onOpenTickets} title="GitHub 工单"><span>☰</span><span className="sidebar-label">工单</span></button>
        <button className="settings-nav" onClick={props.onOpenSettings} title="运行设置"><span>⚙</span><span className="sidebar-label">运行设置</span></button>
      </div>
    </aside>
  );
}
