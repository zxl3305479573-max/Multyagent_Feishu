type Props = {
  project: string;
  projects: string[];
  stats: { taskCount: number; eventCount: number };
  pendingCommand: string | null;
  onSelectProject: (project: string) => void;
  onCommand: (command: "export_project" | "cleanup_history" | "restore_history") => void;
};

export function ProjectView({ project, projects, stats, pendingCommand, onSelectProject, onCommand }: Props) {
  return (
    <div className="central-view settings-content">
      <div className="project-drawer-summary"><span>当前工作项目</span><strong>{project || "全部项目"}</strong><small>仅查看并操作此项目的任务与事件；Agent 上下文彼此隔离。</small></div>
      <label className="project-drawer-picker">切换项目<select value={project} onChange={(event) => onSelectProject(event.target.value)}><option value="">全部项目</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="project-drawer-stats"><div><strong>{stats.taskCount}</strong><span>任务</span></div><div><strong>{stats.eventCount}</strong><span>事件</span></div></div>
      <div className="configured-list">
        <h3>项目历史</h3>
        <button className="project-action-button" onClick={() => onCommand("export_project")} disabled={Boolean(pendingCommand)}>{pendingCommand === "export_project" ? "正在导出…" : "导出项目历史"}</button>
        <button className="project-action-button" onClick={() => onCommand("cleanup_history")} disabled={Boolean(pendingCommand)}>{pendingCommand === "cleanup_history" ? "正在归档…" : "归档较早历史"}</button>
        <button className="project-action-button" onClick={() => onCommand("restore_history")} disabled={Boolean(pendingCommand)}>{pendingCommand === "restore_history" ? "正在恢复…" : "恢复归档历史"}</button>
      </div>
    </div>
  );
}
