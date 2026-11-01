import type { Task, WorkspaceView } from "../types";
import { snapshotStatus, taskStatus } from "../format";
import { useSkinPack } from "../themes/SkinContext";
import { StatusMood } from "./AgentVisuals";

type Props = {
  collapsed: boolean;
  activeView: WorkspaceView;
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
  onOpenMemory: () => void;
  onOpenFiles: () => void;
  onOpenHistory: () => void;
  onOpenPermissions: () => void;
  onOpenMonitor: () => void;
  onOpenSettings: () => void;
  onOpenTickets: () => void;
  onOpenCapabilities: () => void;
  onOpenCustomAgents: () => void;
  onNewProject: () => void;
  onNewConversation: () => void;
};

export function connectionClass(connection: string) {
  return connection === "已连接" ? "connected" : connection === "连接失败" ? "failed" : "pending";
}

export function Sidebar(props: Props) {
  const { collapsed, project, projects, tasks, selected, connection, projectStats, activeView } = props;
  const skin = useSkinPack();
  const brandName = skin.brand.displayName;
  const navClass = (view: WorkspaceView) => `settings-nav ${activeView === view ? "is-selected" : ""}`;
  return (
    <aside className="sidebar" aria-label="项目和历史">
      <div className="brand-row"><span className="brand-mark">{skin.assets.logo ? <img src={skin.assets.logo} alt="" /> : Array.from(brandName)[0] || "A"}</span><span className="brand-name">{brandName}</span><button className="icon-button sidebar-collapse" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={props.onToggleCollapsed}>{collapsed ? "›" : "‹"}</button></div>
      <div className="sidebar-create-actions">
        <button className="project-action-button" onClick={props.onNewProject} title="新建项目"><span>＋</span><span className="sidebar-label">新建项目</span></button>
        <button className="project-action-button" onClick={props.onNewConversation} title="新建项目对话"><span>＋</span><span className="sidebar-label">新建项目对话</span></button>
      </div>
      <div className="sidebar-nav-label sidebar-label">工作区</div>
      <label className="project-picker"><span className="sidebar-label">当前项目</span><select aria-label="选择项目" value={project} onChange={(event) => props.onSelectProject(event.target.value)}><option value="">全部项目</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="sidebar-section-heading"><span>最近任务 <b>{tasks.length}</b></span><button className="icon-button" aria-label="刷新任务" title="刷新任务" onClick={props.onRefresh}>↻</button></div>
      <nav className="task-nav" aria-label="最近任务">
        {tasks.length === 0 ? <div className={`sidebar-empty ${skin.assets.emptyTasks ? "has-illustration" : ""}`}>
          {skin.assets.emptyTasks
            ? <img src={skin.assets.emptyTasks} alt="" aria-hidden="true" />
            : <span className="neutral-empty-visual" aria-hidden="true">A</span>}
          <span>{project ? "当前项目暂无任务" : "暂无历史任务"}</span>
        </div> : tasks.map((task) => {
          const status = snapshotStatus(task);
          return <button key={task.task_id} className={`nav-task ${task.task_id === selected ? "is-selected" : ""}`} onClick={() => props.onSelectTask(task.task_id || "")} title={task.title || task.task_id || "未命名任务"}>
            <span className="nav-task-icon">{(task.title || task.task_id || "A").slice(0, 1).toUpperCase()}</span><span className="nav-task-title">{task.title || task.task_id || "未命名任务"}</span>
            <span className="nav-task-meta"><span>{task.project_name || "未归属项目"}</span><span className={`status-dot status-${status}`} /><StatusMood status={status} label={taskStatus(task)} />{taskStatus(task)}</span>
          </button>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className={`connection-line ${connectionClass(connection)}`}><span className="connection-dot" />{connection}</div>
        {project && <button className="project-context-strip" onClick={props.onOpenProject} aria-label="打开项目上下文" title="项目上下文"><span className="project-context-icon">⌂</span><span className="project-context-details"><span className="project-context-title"><strong>{project}</strong><span>当前项目</span></span><span className="project-context-meta"><span>{projectStats.taskCount} 个任务</span><span>{projectStats.eventCount} 条事件</span></span><span className="project-context-isolated">上下文已隔离 · 管理项目</span></span></button>}
        <div className="sidebar-nav-label sidebar-label">Agent 能力</div>
        <button className={navClass("memory")} onClick={props.onOpenMemory} title="记忆中心"><span>◇</span><span className="sidebar-label">记忆中心</span></button>
        <button className={navClass("capabilities")} onClick={props.onOpenCapabilities} title="技能中心"><span>✦</span><span className="sidebar-label">技能中心</span></button>
        <button className={navClass("custom_agents")} onClick={props.onOpenCustomAgents} title="自定义 Agent"><span>⊕</span><span className="sidebar-label">自定义 Agent</span></button>
        <button className={navClass("files")} onClick={props.onOpenFiles} title="文件管理"><span>▤</span><span className="sidebar-label">文件管理</span></button>
        <div className="sidebar-nav-label sidebar-label">工作记录</div>
        <button className={navClass("history")} onClick={props.onOpenHistory} title="任务历史"><span>↺</span><span className="sidebar-label">任务历史</span></button>
        <button className={navClass("tickets")} onClick={props.onOpenTickets} title="GitHub 工单"><span>☰</span><span className="sidebar-label">工单</span><b className="sidebar-count">{projectStats.taskCount}</b></button>
        <div className="sidebar-nav-label sidebar-label">系统管理</div>
        <button className={navClass("permissions")} onClick={props.onOpenPermissions} title="权限管理"><span>⛨</span><span className="sidebar-label">权限管理</span></button>
        <button className={navClass("monitor")} onClick={props.onOpenMonitor} title="运行监控"><span>⌁</span><span className="sidebar-label">运行监控</span></button>
        <button className={navClass("project")} onClick={props.onOpenProject} title="项目上下文"><span>⌂</span><span className="sidebar-label">项目上下文</span></button>
        <button className={navClass("settings")} onClick={props.onOpenSettings} title="运行设置"><span>⚙</span><span className="sidebar-label">运行设置</span></button>
      </div>
    </aside>
  );
}
