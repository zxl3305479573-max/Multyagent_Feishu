import type { Task } from "../types";
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
  onSelectTask: (taskId: string) => void;
  connection: string;
  projectStats: { taskCount: number; eventCount: number };
  onOpenProject: () => void;
  onOpenSettings: () => void;
  onOpenTickets: () => void;
  onOpenCapabilities: () => void;
  onNewProject: () => void;
  onNewConversation: () => void;
};

export function connectionClass(connection: string) {
  return connection === "已连接" ? "connected" : connection === "连接失败" ? "failed" : "pending";
}

export function Sidebar(props: Props) {
  const { collapsed, project, projects, tasks, selected, connection, projectStats } = props;
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
      <div className="sidebar-bottom">
        <div className={`connection-line ${connectionClass(connection)}`}><span className="connection-dot" />{connection}</div>
        {project && <button className="project-context-strip" onClick={props.onOpenProject} aria-label="打开项目上下文" title="项目上下文"><span className="project-context-icon">⌂</span><span className="project-context-details"><span className="project-context-title"><strong>{project}</strong><span>当前项目</span></span><span className="project-context-meta"><span>{projectStats.taskCount} 个任务</span><span>{projectStats.eventCount} 条事件</span></span><span className="project-context-isolated">上下文已隔离 · 管理项目</span></span></button>}
        <button className="settings-nav" onClick={props.onOpenTickets} title="GitHub 工单"><span>☰</span><span className="sidebar-label">工单</span></button>
        <button className="settings-nav" onClick={props.onOpenCapabilities} title="机器人能力"><span>✦</span><span className="sidebar-label">机器人能力</span></button>
        <button className="settings-nav" onClick={props.onOpenSettings} title="运行设置"><span>⚙</span><span className="sidebar-label">运行设置</span></button>
      </div>
    </aside>
  );
}
