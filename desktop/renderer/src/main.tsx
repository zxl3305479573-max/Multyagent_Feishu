import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function formatProjectCommandFeedback(command: string | undefined, result: DesktopMessage["result"] = {}) {
  if (command === "export_project") return `项目已导出：${result?.outputFile || "已生成导出文件"} · ${Number(result?.taskCount) || 0} 个任务 · ${Number(result?.eventCount) || 0} 条事件`;
  if (command === "cleanup_history") return `历史已归档：归档 ${Number(result?.archived) || 0} 条，保留 ${Number(result?.kept) || 0} 条`;
  if (command === "restore_history") return `历史已恢复：恢复 ${Number(result?.restored) || 0} 条记录`;
  return "";
}

type Task = {
  task_id?: string;
  project_name?: string | null;
  title?: string;
  description?: string;
  status?: string;
  status_snapshot?: { status?: string; latest_event?: string };
};
type EventRecord = {
  event_id?: string;
  type?: string;
  task_id?: string;
  agent?: string;
  target?: string;
  project_name?: string;
  timestamp?: string;
  title?: string;
  summary?: string;
  text?: string;
  error?: string;
  tool?: string;
  command?: string;
  file_path?: string;
  artifact_count?: number;
  status?: string;
  agents?: string[];
  assignments?: Array<{ agentKey?: string; task?: string; reason?: string }>;
};
type Agent = { key: string; displayName?: string; enabled?: boolean };
type DesktopMessage = {
  type: string;
  command?: string;
  tasks?: Task[];
  projects?: string[];
  agents?: Agent[];
  project?: string | null;
  event?: EventRecord;
  result?: { taskId?: string; projectName?: string; storagePath?: string; title?: string; retried?: boolean; resumed?: number; attempt?: number; status?: string; outputFile?: string; archived?: number; restored?: number; [key: string]: unknown };
  error?: string;
};
type DesktopSocket = {
  send: (value: unknown) => void;
  subscribe: (listener: (message: DesktopMessage) => void) => () => void;
  close: () => void;
};
type InspectorView = "activity" | "settings" | "project";
type PendingSubmission = { projectName: string; title: string; description: string };
type ControlCommand = "pause" | "resume" | "terminate" | "retry";
let activeSocket: DesktopSocket | null = null;

declare global {
  interface Window {
    desktop?: {
      connect: (project?: string) => Promise<DesktopSocket>;
      credentials?: { list: () => Promise<string[]>; set: (key: string, value: string) => Promise<unknown> };
      restartGateway?: () => Promise<{ restarted: boolean }>;
      selectDirectory?: () => Promise<string>;
      quit?: () => Promise<unknown>;
    };
  }
}

const credentialOptions = [
  ["FEISHU_PROJECT_MANAGER_APP_ID", "项目经理 App ID"],
  ["FEISHU_PROJECT_MANAGER_APP_SECRET", "项目经理 App Secret"],
  ["FEISHU_ARCHITECT_APP_ID", "架构设计师 App ID"],
  ["FEISHU_ARCHITECT_APP_SECRET", "架构设计师 App Secret"],
  ["FEISHU_FRONTEND_DEVELOPER_APP_ID", "前端开发 App ID"],
  ["FEISHU_FRONTEND_DEVELOPER_APP_SECRET", "前端开发 App Secret"],
  ["FEISHU_BACKEND_DEVELOPER_APP_ID", "后端开发 App ID"],
  ["FEISHU_BACKEND_DEVELOPER_APP_SECRET", "后端开发 App Secret"],
  ["FEISHU_TESTER_APP_ID", "测试 App ID"],
  ["FEISHU_TESTER_APP_SECRET", "测试 App Secret"],
  ["FEISHU_AUDITOR_APP_ID", "审计 App ID"],
  ["FEISHU_AUDITOR_APP_SECRET", "审计 App Secret"],
  ["DEEPSEEK_API_KEY", "DeepSeek API Key"],
  ["OPENAI_API_KEY", "OpenAI API Key"],
] as const;

const eventLabels: Record<string, string> = {
  task_started: "开始规划任务",
  task_plan_created: "制定了执行计划",
  task_plan_completed: "任务计划已完成",
  task_completed: "完成当前阶段",
  task_settle: "任务阶段已结束",
  task_hold: "任务已暂停",
  task_resumed: "任务已继续",
  task_terminated: "任务已终止",
  task_cancelled: "任务已取消",
  task_failed: "执行遇到问题",
  dispatch_started: "开始执行分配任务",
  dispatch_completed: "完成分配任务",
  dispatch_failed: "分配任务失败",
  dispatch_cancelled: "分配任务已取消",
  agent_started: "开始工作",
  agent_finished: "完成本轮工作",
  tool_call: "开始使用工具",
  tool_result: "工具执行完成",
  error: "执行遇到问题",
  delivery_received: "提交了阶段结果",
  approval_required: "等待确认",
  control_applied: "任务控制已更新",
};

const statusLabels: Record<string, string> = {
  received: "已接收",
  queued: "排队中",
  running: "执行中",
  active: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已终止",
  paused: "已暂停",
  waiting: "等待中",
};

function rootTaskId(taskId?: string) {
  return String(taskId || "").split(":")[0];
}

function eventTime(event: EventRecord) {
  const time = event.timestamp ? new Date(event.timestamp).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function taskStatus(task?: Task) {
  const status = task?.status_snapshot?.status || task?.status || "received";
  return statusLabels[status] || status;
}

function mergeTasks(previous: Task[], incoming: Task[]) {
  const byId = new Map(previous.filter((task) => task.task_id).map((task) => [task.task_id, task]));
  for (const task of incoming) {
    if (!task.task_id) continue;
    const old = byId.get(task.task_id);
    byId.set(task.task_id, {
      ...old,
      ...task,
      status_snapshot: {
        ...(old?.status_snapshot || {}),
        ...(task.status_snapshot || {}),
      },
    });
  }
  return [...byId.values()];
}

type AgentExecutionGroup = {
  key: string;
  displayName: string;
  events: EventRecord[];
  status: string;
};

function agentStatus(events: EventRecord[]) {
  const latest = [...events].sort((a, b) => eventTime(b) - eventTime(a))[0];
  if (!latest) return "waiting";
  if (latest.status === "failed" || latest.type === "error" || latest.type?.includes("failed")) return "failed";
  if (["task_hold", "approval_required"].includes(latest.type || "")) return latest.type === "task_hold" ? "paused" : "waiting";
  if (["task_completed", "task_settle", "agent_finished", "delivery_received"].includes(latest.type || "")) return "completed";
  return "running";
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [project, setProject] = useState("");
  const [taskProject, setTaskProject] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [connection, setConnection] = useState("连接中");
  const [notice, setNotice] = useState("");
  const [inspector, setInspector] = useState<InspectorView>("activity");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [credentialKey, setCredentialKey] = useState<string>(credentialOptions[0][0]);
  const [credentialValue, setCredentialValue] = useState("");
  const [configuredCredentials, setConfiguredCredentials] = useState<string[]>([]);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectPathInput, setProjectPathInput] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<ControlCommand | null>(null);
  const [pendingProjectCommand, setPendingProjectCommand] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [collapsedByTask, setCollapsedByTask] = useState<Record<string, Record<string, boolean>>>({});
  const pendingSubmission = useRef<PendingSubmission | null>(null);
  const selectedTask = useMemo(() => tasks.find((task) => task.task_id === selected), [tasks, selected]);
  const taskEvents = useMemo(() => {
    const selectedRoot = rootTaskId(selected);
    if (!selectedRoot) return [];
    return events
      .filter((event) => rootTaskId(event.task_id) === selectedRoot)
      .sort((a, b) => eventTime(a) - eventTime(b));
  }, [events, selected]);
  const agentExecutionGroups = useMemo<AgentExecutionGroup[]>(() => {
    const groups = new Map<string, EventRecord[]>();
    for (const event of taskEvents) {
      if (event.type === "task_created") continue;
      const key = event.agent || event.target || "system";
      groups.set(key, [...(groups.get(key) || []), event]);
    }
    return [...groups.entries()].map(([key, groupEvents]) => ({
      key,
      displayName: key === "system" ? "系统" : agents.find((agent) => agent.key === key)?.displayName || key,
      events: groupEvents.sort((a, b) => eventTime(a) - eventTime(b)),
      status: agentStatus(groupEvents),
    }));
  }, [agents, taskEvents]);
  const inspectorEvents = useMemo(() => selected
    ? taskEvents
    : events
      .filter((event) => (!project || event.project_name === project) && (!selectedAgent || event.agent === selectedAgent || event.target === selectedAgent))
      .sort((a, b) => eventTime(a) - eventTime(b)), [events, project, selected, selectedAgent, taskEvents]);
  const agentCards = useMemo(() => agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => {
      const matchingEvents = events.filter((event) => (!project || event.project_name === project) && (event.agent === agent.key || event.target === agent.key));
      const latest = [...matchingEvents].sort((a, b) => eventTime(b) - eventTime(a))[0];
      const taskIds = new Set(matchingEvents.map((event) => rootTaskId(event.task_id)).filter(Boolean));
      return { agent, status: agentStatus(matchingEvents), latest, taskCount: taskIds.size };
    }), [agents, events, project]);
  const projectStats = useMemo(() => ({
    taskCount: tasks.filter((task) => !project || task.project_name === project).length,
    eventCount: events.filter((event) => !project || event.project_name === project).length,
  }), [tasks, events, project]);
  const hasManagerCredentials = configuredCredentials.includes("FEISHU_PROJECT_MANAGER_APP_ID")
    && configuredCredentials.includes("FEISHU_PROJECT_MANAGER_APP_SECRET");

  useEffect(() => {
    let socket: DesktopSocket | null = null;
    let unsubscribe = () => {};
    (async () => {
      if (!window.desktop) {
        setConnection("浏览器预览");
        return;
      }
      socket = await window.desktop.connect(project);
      const currentSocket = socket;
      activeSocket = currentSocket;
      unsubscribe = currentSocket.subscribe((message) => {
        if (message.type === "ready") {
          setTasks((current) => mergeTasks(current, message.tasks || []));
          setProjects((current) => [...new Set([...current, ...(message.projects || [])])].sort());
          setAgents(message.agents || []);
          setTaskProject((current) => current || message.project || message.projects?.[0] || "");
          setSelected((current) => current || message.tasks?.[0]?.task_id || "");
          setConnection("已连接");
          if (pendingSubmission.current?.projectName === project) {
            const pending = pendingSubmission.current;
            pendingSubmission.current = null;
            currentSocket.send({ type: "command", command: "submit_task", ...pending, requestId: crypto.randomUUID() });
            setNotice("已连接目标项目，正在创建任务…");
          }
        } else if (message.type === "command_result") {
          if (message.command === "create_project" && message.result?.projectName) {
            const created = message.result.projectName;
            setProjects((current) => current.includes(created) ? current : [...current, created].sort());
            setProject(created);
            setTaskProject(created);
            setProjectModalOpen(false);
            setProjectNameInput("");
            setProjectPathInput("");
            setCreatingProject(false);
            setNotice(`项目已创建：${created}`);
          }
          if (message.command === "submit_task" && message.result?.taskId) {
            const task = {
              task_id: message.result.taskId,
              project_name: message.result.projectName,
              title: message.result.title,
              status: "received",
            };
            setTasks((current) => mergeTasks(current, [task]));
            setSelected(task.task_id || "");
            setSelectedAgent("");
          }
          const commandNames: Record<string, string> = {
            retry: "重试任务",
            pause: "暂停任务", resume: "继续任务", terminate: "终止任务",
            export_project: "导出项目历史", cleanup_history: "归档历史", restore_history: "恢复历史",
          };
          if (["pause", "resume", "terminate", "retry"].includes(message.command || "")) setPendingCommand(null);
          if (["export_project", "cleanup_history", "restore_history"].includes(message.command || "")) {
            setPendingProjectCommand(null);
            if (!message.error) setRefreshVersion((version) => version + 1);
          }
          const projectFeedback = formatProjectCommandFeedback(message.command, message.result);
          if (!message.error && projectFeedback) setNotice(projectFeedback);
          setNotice(message.error
            ? `操作失败：${message.error}`
            : message.result?.taskId ? "任务已创建，正在连接项目经理…" : `${commandNames[message.command || ""] || "操作"}已受理`);
          if (!message.error && projectFeedback) setNotice(projectFeedback);
        } else if (message.type === "event" && message.event) {
          const event = message.event;
          setEvents((current) => {
            if (event.event_id && current.some((item) => item.event_id === event.event_id)) return current;
            return [...current.slice(-999), event];
          });
          if (event.type === "task_created" && event.task_id) {
            setTasks((current) => current.some((task) => task.task_id === event.task_id)
              ? current
              : [{ task_id: event.task_id, project_name: event.project_name, title: event.title, description: event.text, status: "received" }, ...current]);
          }
          if (event.task_id) {
            const rootId = rootTaskId(event.task_id);
            const lifecycleStatus: Record<string, string> = {
              task_started: "running", task_hold: "paused", task_resumed: "running",
              task_completed: "completed", task_terminated: "cancelled", task_cancelled: "cancelled", task_failed: "failed",
            };
            if (event.type === "control_applied") {
              lifecycleStatus.control_applied = event.command === "pause" ? "paused" : event.command === "terminate" ? "cancelled" : event.command === "retry" || event.command === "resume" ? "running" : "";
            }
            const nextStatus = lifecycleStatus[event.type || ""];
            setTasks((current) => current.map((task) => task.task_id === rootId
              ? { ...task, status_snapshot: { ...(task.status_snapshot || {}), latest_event: event.type, ...(nextStatus ? { status: nextStatus } : {}) } }
              : task));
          }
        }
      });
    })().catch((error) => {
      setConnection("连接失败");
      setNotice(`无法连接本地任务服务：${String(error?.message || error)}`);
    });
    return () => {
      unsubscribe();
      if (activeSocket === socket) activeSocket = null;
      socket?.close();
    };
  }, [project, refreshVersion]);

  useEffect(() => {
    window.desktop?.credentials?.list?.().then(setConfiguredCredentials).catch(() => {});
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openNewTask();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const send = (command: string, values: Record<string, unknown> = {}) => {
    if (!selected || !activeSocket) return;
    activeSocket.send({ type: "command", command, taskId: selected, ...values, requestId: crypto.randomUUID() });
  };

  const sendControl = (command: ControlCommand) => {
    if (!selected || !activeSocket || pendingCommand) return;
    if (command === "terminate" && !window.confirm("确定终止当前任务吗？终止后仍会保留历史，但不能继续执行。")) return;
    setPendingCommand(command);
    send(command, command === "retry" ? { error: selectedTask?.status_snapshot?.latest_event || "manual retry" } : {});
  };

  const projectCommand = (command: string) => {
    if (!taskProject.trim() && !project.trim()) {
      setNotice("先选择一个项目，再执行历史操作");
      return;
    }
    const selectedProject = project || taskProject;
    if (!activeSocket) return;
    if (pendingProjectCommand) return;
    setPendingProjectCommand(command);
    setNotice(command === "export_project" ? "正在导出当前项目历史…" : command === "cleanup_history" ? "正在归档当前项目历史…" : "正在恢复当前项目历史…");
    activeSocket.send({
        type: "command",
        command,
        projectName: selectedProject,
        ...(command === "cleanup_history" ? { keep: 1000 } : {}),
        requestId: crypto.randomUUID(),
      });
  };

  const openNewTask = () => {
    setSelected("");
    setSelectedAgent("");
    setInspectorOpen(false);
    setInspector("activity");
    setTaskProject(project || taskProject || projects[0] || "");
    setTitle("");
    setDescription("");
    setNotice("");
  };

  const openNewProject = () => {
    setProjectNameInput("");
    setProjectPathInput("");
    setProjectModalOpen(true);
    setNotice("");
  };

  const createProject = (event: React.FormEvent) => {
    event.preventDefault();
    const name = projectNameInput.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name)) {
      setNotice("项目名需使用 2-64 位小写字母、数字或连字符");
      return;
    }
    if (!activeSocket) {
      setNotice("本地任务服务尚未连接");
      return;
    }
    setCreatingProject(true);
    activeSocket.send({ type: "command", command: "create_project", projectName: name, storagePath: projectPathInput.trim() || undefined, requestId: crypto.randomUUID() });
  };

  const chooseProjectDirectory = async () => {
    const selectedPath = await window.desktop?.selectDirectory?.();
    if (selectedPath) setProjectPathInput(selectedPath);
  };

  const saveCredential = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!window.desktop?.credentials || !credentialValue.trim()) {
      setNotice("输入凭据后即可安全保存");
      return;
    }
    try {
      await window.desktop.credentials.set(credentialKey, credentialValue.trim());
      setConfiguredCredentials((current) => current.includes(credentialKey) ? current : [...current, credentialKey]);
      setCredentialValue("");
      setNotice(`凭据已安全保存：${credentialOptions.find(([key]) => key === credentialKey)?.[1] || credentialKey}`);
    } catch (error) {
      setNotice(`凭据保存失败：${String(error)}`);
    }
  };

  const submitTask = (event: React.FormEvent) => {
    event.preventDefault();
    if (!taskProject.trim() || !description.trim()) {
      setNotice("填写项目和任务描述后即可开始");
      return;
    }
    if (taskProject.trim() !== project && project) {
      pendingSubmission.current = { projectName: taskProject.trim(), title: title.trim(), description: description.trim() };
      setConnection("连接中");
      setProject(taskProject.trim());
      setNotice("正在切换到目标项目，连接就绪后会自动提交…");
      return;
    }
    if (!activeSocket) {
      setNotice("任务提交需要在桌面应用中运行");
      return;
    }
    activeSocket.send({
        type: "command",
        command: "submit_task",
        projectName: taskProject.trim(),
        title: title.trim(),
        description: description.trim(),
        requestId: crypto.randomUUID(),
      });
    setNotice("正在创建任务…");
  };

  const statusClass = connection === "已连接" ? "connected" : connection === "连接失败" ? "failed" : "pending";
  const showSettings = () => {
    setInspector("settings");
    setInspectorOpen(true);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="项目和历史">
        <div className="brand-row"><span className="brand-mark">A</span><span>Agent 工作台</span><button className="icon-button sidebar-collapse" aria-label="收起侧栏" title="收起侧栏">‹</button></div>
        <button className="new-task-button" onClick={openNewTask}><span>＋</span> 新建任务 <kbd>Ctrl K</kbd></button>
        <label className="project-picker"><span>当前项目</span><select aria-label="选择项目" value={project} onChange={(event) => setProject(event.target.value)}><option value="">全部项目</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <div className="sidebar-section-heading"><span>最近任务</span><button className="icon-button" aria-label="刷新任务" title="刷新任务" onClick={() => setProject((current) => current)}>↻</button></div>
        <nav className="task-nav" aria-label="最近任务">
          {tasks.length === 0 ? <div className="sidebar-empty">暂无历史任务</div> : tasks.map((task) => (
            <button key={task.task_id} className={`nav-task ${task.task_id === selected ? "is-selected" : ""}`} onClick={() => { setSelected(task.task_id || ""); setSelectedAgent(""); setInspectorOpen(false); }}>
              <span className="nav-task-title">{task.title || task.task_id || "未命名任务"}</span>
              <span className="nav-task-meta"><span>{task.project_name || "未归属项目"}</span><span className={`status-dot status-${task.status_snapshot?.status || task.status || "received"}`} />{taskStatus(task)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-project-actions"><button className="project-action-button" onClick={openNewProject}>＋ 新建项目</button>{project && <button className="project-action-button" onClick={() => { openNewTask(); setProject(project); }}>＋ 当前项目新建对话</button>}</div>
        {selectedTask && <div className="sidebar-task-actions">
          <div className="sidebar-task-actions-heading"><span>当前任务</span><span className={`task-state state-${selectedTask.status_snapshot?.status || selectedTask.status || "received"}`}><i />{taskStatus(selectedTask)}</span></div>
          <div className="sidebar-task-actions-buttons">
            <button onClick={() => sendControl("pause")} disabled={pendingCommand !== null || ["paused", "cancelled", "completed", "failed"].includes(selectedTask.status_snapshot?.status || selectedTask.status || "")}>{pendingCommand === "pause" ? "处理中…" : "暂停"}</button>
            <button onClick={() => sendControl("resume")} disabled={pendingCommand !== null || selectedTask.status_snapshot?.status !== "paused"}>{pendingCommand === "resume" ? "处理中…" : "继续"}</button>
            {(selectedTask.status_snapshot?.status || selectedTask.status) === "failed" && <button onClick={() => sendControl("retry")} disabled={pendingCommand !== null}>{pendingCommand === "retry" ? "重试中…" : "重试"}</button>}
            <button className="sidebar-terminate" onClick={() => sendControl("terminate")} disabled={pendingCommand !== null || ["cancelled", "completed", "failed"].includes(selectedTask.status_snapshot?.status || selectedTask.status || "")}>{pendingCommand === "terminate" ? "终止中…" : "终止"}</button>
          </div>
          <button className="sidebar-observe-button" onClick={() => { setInspector("activity"); setInspectorOpen((open) => !open); }}>打开执行观察</button>
        </div>}
        <div className="sidebar-bottom">
          <div className={`connection-line ${statusClass}`}><span className="connection-dot" />{connection}</div>
          {project && <button className="project-context-strip" onClick={() => { setInspector("project"); setInspectorOpen(true); }} aria-label="打开项目上下文"><span className="project-context-title"><strong>{project}</strong><span>当前项目</span></span><span className="project-context-meta"><span>{projectStats.taskCount} 个任务</span><span>{projectStats.eventCount} 条事件</span></span><span className="project-context-isolated">上下文已隔离 · 管理项目</span></button>}
          {agentCards.length > 0 && <div className="agent-card-list"><div className="sidebar-section-heading"><span>Agent 状态</span><span className="agent-count">{agentCards.length}</span></div>{agentCards.map(({ agent, status, latest, taskCount }) => <button key={agent.key} className={`agent-card ${selectedAgent === agent.key ? "is-selected" : ""}`} onClick={() => { setSelected(""); setSelectedAgent(agent.key); setInspector("activity"); setInspectorOpen(true); }}><span className={`agent-card-dot agent-card-${status}`} /><span className="agent-card-body"><span className="agent-card-title"><strong>{agent.displayName || agent.key}</strong><span>{statusLabels[status] || status}</span></span><span className="agent-card-recent">{latest?.summary || eventLabels[latest?.type || ""] || "暂无结构化事件"}</span><span className="agent-card-meta">{taskCount} 个任务{latest?.timestamp ? ` · ${new Date(latest.timestamp).toLocaleTimeString()}` : ""}</span></span><span className="agent-card-open">观察</span></button>)}</div>}
          {agents.length > 0 && <div className="agent-nav-block"><div className="sidebar-section-heading"><span>Agent</span></div>{agents.filter((agent) => agent.enabled !== false).map((agent) => <button key={agent.key} className={`agent-nav ${selectedAgent === agent.key ? "is-selected" : ""}`} onClick={() => { setSelected(""); setSelectedAgent(agent.key); setInspector("activity"); setInspectorOpen(true); }}>{agent.displayName || agent.key}<span>观察</span></button>)}</div>}
          <button className="settings-nav" onClick={showSettings}><span>⚙</span> 运行设置</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div className="conversation-heading">
            <h1>{selectedTask?.title || (selected ? selected : "新建任务")}</h1>
            <span className="header-project">{selectedTask?.project_name || project || "选择项目"}</span>
          </div>
        </header>

        {notice && <div className="notice-bar" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
        {connection === "连接失败" && <div className="connection-alert" role="alert"><div><strong>本地任务服务暂不可用</strong><span>检查网关是否运行，或打开运行设置重新启动。</span></div><button className="quiet-button" onClick={showSettings}>打开运行设置</button></div>}
        {!hasManagerCredentials && connection === "已连接" && <div className="setup-hint"><span>尚未配置项目经理凭据，任务暂时无法开始。</span><button onClick={showSettings}>配置凭据</button></div>}

        <div className="conversation-scroll" key={selected || "empty"}>
          {!selectedTask ? (
            <div className="welcome-state">
              <span className="welcome-mark">A</span>
              <h2>接下来要完成什么？</h2>
              <p>描述目标和约束，项目经理会规划任务并分配给合适的 Agent。</p>
              <div className="welcome-chips"><span>按项目隔离上下文</span><span>并行执行独立任务</span><span>随时观察与控制</span></div>
            </div>
          ) : (
            <div className="conversation-content">
              {taskEvents.length === 0 && <div className="conversation-empty"><span className="empty-spinner" />正在加载任务记录…</div>}
              {taskEvents.filter((event) => event.type === "task_created").map((event, index) => <article className="message user-message" key={event.event_id || `request-${index}`}><div className="message-avatar user-avatar">你</div><div className="message-body"><div className="message-author">你 <time>{event.timestamp ? new Date(event.timestamp).toLocaleString() : ""}</time></div><p>{selectedTask.description || event.text || selectedTask.title}</p></div></article>)}
              {agentExecutionGroups.map((group) => {
                const taskKey = rootTaskId(selected);
                const collapsed = Boolean(collapsedByTask[taskKey]?.[group.key]);
                return <section className="agent-execution-group" key={group.key}>
                  <button className="agent-execution-group-header" aria-expanded={!collapsed} onClick={() => setCollapsedByTask((current) => ({ ...current, [taskKey]: { ...(current[taskKey] || {}), [group.key]: !collapsed } }))}>
                    <span className="agent-execution-chevron" aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
                    <span className="message-avatar agent-avatar">{group.displayName.slice(0, 1)}</span>
                    <span className="agent-execution-title">{group.displayName}</span>
                    <span className={`agent-execution-status status-${group.status}`}>{statusLabels[group.status] || group.status}</span>
                    <span className="agent-execution-count">{group.events.length} 条</span>
                  </button>
                  {!collapsed && <div className="agent-execution-events">{group.events.map((event, index) => {
                    const summary = event.summary || eventLabels[event.type || ""] || "任务状态已更新";
                    const isError = event.status === "failed" || event.type?.includes("failed") || event.type === "error";
                    return <article className={`message agent-message agent-execution-event ${isError ? "message-error" : ""}`} key={event.event_id || `${event.type}-${index}`}>
                      <div className="message-body">
                        <div className="message-author">{eventLabels[event.type || ""] || event.type || "事件"}<time>{event.timestamp ? new Date(event.timestamp).toLocaleString() : ""}</time></div>
                        <p>{summary}</p>
                        {(event.target || event.tool) && <div className="message-tags">{event.target && <span>分配给 {agents.find((agent) => agent.key === event.target)?.displayName || event.target}</span>}{event.tool && <span>工具 · {event.tool}</span>}</div>}
                        {event.command && <pre className="event-code">{event.command}</pre>}
                        {event.file_path && <p className="event-path">文件：{event.file_path}</p>}
                        {event.error && <p className="event-error">{event.error}</p>}
                        {typeof event.artifact_count === "number" && event.artifact_count > 0 && <p className="event-artifacts">交付了 {event.artifact_count} 个文件</p>}
                      </div>
                    </article>;
                  })}</div>}
                </section>;
              })}
              {selectedTask.status_snapshot?.status === "running" && <div className="running-indicator"><span className="pulse-dot" />Agent 正在执行</div>}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <form className="composer" onSubmit={submitTask}>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={selectedTask ? "继续描述下一个任务…" : "描述你想完成的任务…"} rows={3} aria-label="任务描述" />
            <div className="composer-send-row"><button className="send-button" type="submit" disabled={!description.trim() || !taskProject.trim() || connection !== "已连接"} aria-label="提交任务" title="提交新任务">↑</button></div>
          </form>
        </div>
      </section>

      {projectModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingProject) setProjectModalOpen(false); }}><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><header><div><h2 id="new-project-title">新建项目</h2><p>项目上下文和任务历史会按项目隔离。</p></div><button className="icon-button" aria-label="关闭" onClick={() => setProjectModalOpen(false)} disabled={creatingProject}>×</button></header><form onSubmit={createProject}><label>项目名<input autoFocus value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} placeholder="例如：customer-portal" disabled={creatingProject} /></label><label>项目存储路径<span className="path-input-row"><input value={projectPathInput} onChange={(event) => setProjectPathInput(event.target.value)} placeholder="不填则使用工作区目录" disabled={creatingProject} /><button type="button" className="quiet-button" onClick={chooseProjectDirectory} disabled={creatingProject}>选择目录</button></span></label><div className="modal-actions"><button type="button" className="quiet-button" onClick={() => setProjectModalOpen(false)} disabled={creatingProject}>取消</button><button type="submit" className="primary-button" disabled={creatingProject}>{creatingProject ? "创建中…" : "创建项目"}</button></div></form></section></div>}
      {inspectorOpen && <>
        <button className="inspector-backdrop" aria-label="关闭侧栏" onClick={() => setInspectorOpen(false)} />
        <aside className="inspector" aria-label={inspector === "settings" ? "运行设置" : "执行观察"}>
          <header className="inspector-header"><div><h2>{inspector === "settings" ? "运行设置" : inspector === "project" ? "项目上下文" : selectedAgent ? `${agents.find((agent) => agent.key === selectedAgent)?.displayName || selectedAgent} · 观察` : "执行过程"}</h2><p>{inspector === "settings" ? "管理本机连接凭据" : inspector === "project" ? project || "选择一个项目" : selectedTask?.project_name || project || "选择任务查看执行状态"}</p></div><button className="icon-button" aria-label="关闭观察栏" onClick={() => setInspectorOpen(false)}>×</button></header>
          {inspector === "settings" ? <div className="settings-content"><div className="settings-intro"><span className="settings-icon">⚙</span><div><strong>安全存储</strong><p>凭据使用 Windows 系统加密保存在本机，不写入项目日志。</p></div></div><form className="settings-form" onSubmit={saveCredential}><label>凭据类型<select value={credentialKey} onChange={(event) => setCredentialKey(event.target.value)}>{credentialOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>凭据值<input type="password" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} placeholder={configuredCredentials.includes(credentialKey) ? "已配置，输入新值以覆盖" : "粘贴凭据"} /></label><button className="primary-button" type="submit">安全保存</button></form><div className="configured-list"><h3>已配置凭据</h3>{configuredCredentials.length ? configuredCredentials.map((key) => <div className="configured-item" key={key}><span>{credentialOptions.find(([name]) => name === key)?.[1] || key}</span><span className="configured-check">已保存</span></div>) : <p>尚未保存凭据</p>}</div><div className="gateway-box"><div><strong>本地任务服务</strong><p>保存凭据后重启服务，使变更生效。</p></div><button className="quiet-button" onClick={async () => { try { await window.desktop?.restartGateway?.(); setNotice("本地任务服务已重启"); } catch (error) { setNotice(`服务重启失败：${String(error)}`); } }}>重启服务</button></div></div> : inspector === "project" ? <div className="settings-content"><div className="project-drawer-summary"><span>当前工作项目</span><strong>{project || "全部项目"}</strong><small>仅查看并操作此项目的任务与事件；Agent 上下文彼此隔离。</small></div><label className="project-drawer-picker">切换项目<select value={project} onChange={(event) => { setProject(event.target.value); setSelected(""); setSelectedAgent(""); setInspectorOpen(false); }}><option value="">全部项目</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><div className="project-drawer-stats"><div><strong>{projectStats.taskCount}</strong><span>任务</span></div><div><strong>{projectStats.eventCount}</strong><span>事件</span></div></div><div className="configured-list"><h3>项目历史</h3><button className="project-action-button" onClick={() => projectCommand("export_project")} disabled={Boolean(pendingProjectCommand)}>{pendingProjectCommand === "export_project" ? "正在导出…" : "导出项目历史"}</button><button className="project-action-button" onClick={() => projectCommand("cleanup_history")} disabled={Boolean(pendingProjectCommand)}>{pendingProjectCommand === "cleanup_history" ? "正在归档…" : "归档较早历史"}</button><button className="project-action-button" onClick={() => projectCommand("restore_history")} disabled={Boolean(pendingProjectCommand)}>{pendingProjectCommand === "restore_history" ? "正在恢复…" : "恢复归档历史"}</button></div></div> : <div className="inspector-content">
            {selectedTask ? <div className="task-controls"><div><strong>任务控制</strong><span>{taskStatus(selectedTask)}</span></div><div className="control-buttons"><button onClick={() => send("pause")} disabled={selectedTask.status_snapshot?.status === "paused"}>暂停</button><button onClick={() => send("resume")} disabled={selectedTask.status_snapshot?.status !== "paused"}>继续</button><button className="terminate-button" onClick={() => send("terminate")} disabled={["cancelled", "completed", "failed"].includes(selectedTask.status_snapshot?.status || selectedTask.status || "")}>终止</button></div></div> : <div className="inspector-empty">选择一个任务，查看 Agent 执行阶段和结构化事件。</div>}
            <div className="trace-heading"><h3>{selectedAgent ? "Agent 时间线" : "任务事件"}</h3><span>{inspectorEvents.length} 条记录</span></div>
            {inspectorEvents.map((event, index) => <div className="trace-row" key={event.event_id || `trace-${index}`}><span className={`trace-dot ${event.status === "failed" ? "trace-failed" : ""}`} /><div><strong>{eventLabels[event.type || ""] || event.type || "事件"}</strong><p>{event.agent || event.target || "系统"}{event.tool ? ` · ${event.tool}` : ""}</p>{event.summary && <small>{event.summary}</small>}{event.error && <small className="event-error">{event.error}</small>}<time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ""}</time></div></div>)}
          </div>}
        </aside>
      </>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
