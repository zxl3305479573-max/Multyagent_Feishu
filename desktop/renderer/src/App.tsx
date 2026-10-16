import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentCard, AgentExecutionGroup, ControlCommand, CredentialStatus, DesktopSocket, EventRecord, PendingSubmission, Task, WorkspaceView } from "./types";
import { eventTime, finalResultOf, formatProjectCommandFeedback, mergeTasks, rootTaskId } from "./format";
import { agentStatus, collectArtifacts, executionOwner, executionTiming, groupToolExecutions } from "./execution-view";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import { ProjectView } from "./components/ProjectView";
import { AgentTraceView } from "./components/AgentTraceView";
import { AgentStatusStrip } from "./components/AgentStatusStrip";
import { Composer, ConversationView } from "./components/ConversationView";
import { NewProjectModal } from "./components/NewProjectModal";

let activeSocket: DesktopSocket | null = null;

const COMMAND_NAMES: Record<string, string> = {
  retry: "重试任务",
  pause: "暂停任务", resume: "继续任务", terminate: "终止任务",
  export_project: "导出项目历史", cleanup_history: "归档历史", restore_history: "恢复历史",
};

const EVENT_LIMIT = 1000;
const LIFECYCLE_STATUS: Record<string, string> = {
  task_started: "running", task_hold: "paused", task_resumed: "running",
  task_settle: "completed",
  task_terminated: "cancelled", task_cancelled: "cancelled", task_failed: "failed",
};
const SETTLING_EVENTS = ["task_settle", "task_failed", "task_terminated", "task_cancelled"];

// 按 event_id 去重并保留最近 EVENT_LIMIT 条；批量合并只做一次 Set 查重，避免逐条 O(n) 扫描。
function mergeEvents(current: EventRecord[], incoming: EventRecord[], limit = EVENT_LIMIT): EventRecord[] {
  const seen = new Set(current.map((item) => item.event_id).filter(Boolean));
  const fresh = incoming.filter((event) => {
    if (!event.event_id) return true;
    if (seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  });
  if (!fresh.length) return current;
  const merged = [...current, ...fresh];
  return merged.length > limit ? merged.slice(-limit) : merged;
}

function lifecycleStatusOf(event: EventRecord): string {
  if (event.type === "task_completed") return event.final === true ? "completed" : "running";
  if (event.type === "control_applied") {
    return event.command === "pause" ? "paused" : event.command === "terminate" ? "cancelled" : event.command === "retry" || event.command === "resume" ? "running" : "";
  }
  return LIFECYCLE_STATUS[event.type || ""] || "";
}

// 把一批事件按顺序折叠进任务状态；新任务由 task_created 补出，已结束任务不会被普通事件降级。
function applyEventsToTasks(tasks: Task[], events: EventRecord[]): Task[] {
  if (!events.length) return tasks;
  const next = [...tasks];
  const index = new Map(next.map((task, i) => [task.task_id, i]));
  for (const event of events) {
    if (event.type === "task_created" && event.task_id && !index.has(event.task_id)) {
      next.unshift({ task_id: event.task_id, project_name: event.project_name, title: event.title, description: event.text, status: "received" });
      index.clear();
      next.forEach((task, i) => index.set(task.task_id, i));
    }
    if (!event.task_id) continue;
    const position = index.get(rootTaskId(event.task_id));
    if (position === undefined) continue;
    const task = next[position];
    const status = task.status_snapshot?.status || task.status;
    const terminal = ["completed", "failed", "cancelled"].includes(status || "");
    if (terminal && !SETTLING_EVENTS.includes(event.type || "")) continue;
    const nextStatus = lifecycleStatusOf(event);
    next[position] = { ...task, status_snapshot: { ...(task.status_snapshot || {}), latest_event: event.type, ...(nextStatus ? { status: nextStatus } : {}) } };
  }
  return next;
}

export function App() {
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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("conversation");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [configuredCredentials, setConfiguredCredentials] = useState<string[]>([]);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectPathInput, setProjectPathInput] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<ControlCommand | null>(null);
  const [pendingProjectCommand, setPendingProjectCommand] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [taskHistory, setTaskHistory] = useState<Record<string, EventRecord[]>>({});
  const historyRequests = useRef(new Map<string, string>());
  const [now, setNow] = useState(Date.now());
  const pendingSubmission = useRef<PendingSubmission | null>(null);
  const agentSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const selectedTask = useMemo(() => tasks.find((task) => task.task_id === selected), [tasks, selected]);
  const currentStatus = selectedTask?.status_snapshot?.status || selectedTask?.status;
  const isTaskActive = ["running", "in_progress"].includes(currentStatus || "");
  const settledAt = ["completed", "failed", "cancelled"].includes(currentStatus || "")
    ? selectedTask?.status_snapshot?.updated_at || selectedTask?.updated_at : undefined;
  useEffect(() => {
    if (!isTaskActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isTaskActive]);
  const visibleTasks = useMemo(() => project ? tasks.filter((task) => task.project_name === project) : tasks, [tasks, project]);
  const selectedRoot = rootTaskId(selected);
  const taskEventsLoading = Boolean(selectedRoot) && !(selectedRoot in taskHistory);
  // 选中任务的记录 = 按需拉取的完整历史 + 之后实时推送到全局窗口里的事件。
  const taskEvents = useMemo(() => {
    if (!selectedRoot) return [];
    const live = events.filter((event) => rootTaskId(event.task_id) === selectedRoot);
    return mergeEvents(taskHistory[selectedRoot] || [], live, Infinity)
      .sort((a, b) => eventTime(a) - eventTime(b));
  }, [events, selectedRoot, taskHistory]);
  useEffect(() => {
    if (!selectedRoot || selectedRoot in taskHistory || connection !== "已连接" || !activeSocket) return;
    if ([...historyRequests.current.values()].includes(selectedRoot)) return;
    const requestId = crypto.randomUUID();
    historyRequests.current.set(requestId, selectedRoot);
    activeSocket.send({ type: "command", command: "task_events", taskId: selectedRoot, requestId });
  }, [selectedRoot, taskHistory, connection]);
  const taskStartedAt = taskEvents.find((event) => event.type === "task_started")?.timestamp || selectedTask?.created_at;
  const taskDuration = taskStartedAt ? Math.max(0, (settledAt ? Date.parse(settledAt) : now) - Date.parse(taskStartedAt)) : null;
  const agentExecutionGroups = useMemo<AgentExecutionGroup[]>(() => {
    const groups = new Map<string, EventRecord[]>();
    for (const event of taskEvents) {
      if (event.type === "task_created") continue;
      const key = executionOwner(event);
      groups.set(key, [...(groups.get(key) || []), event]);
    }
    return [...groups.entries()].map(([key, groupEvents]) => {
      const sortedEvents = groupEvents.sort((a, b) => eventTime(a) - eventTime(b));
      const finalResult = finalResultOf(sortedEvents);
      const timing = executionTiming(sortedEvents, now, settledAt);
      const paths = new Set(sortedEvents.flatMap((event) => [event.file_path, ...collectArtifacts(event).map((item) => item.path)]).filter(Boolean).map((path) => path!.replaceAll("\\", "/")));
      return {
        key,
        displayName: agents.find((agent) => agent.key === key)?.displayName || key,
        events: sortedEvents,
        items: groupToolExecutions(sortedEvents.filter((event) => event.type !== "delivery_received")),
        status: agentStatus(sortedEvents, currentStatus),
        assignedTask: [...sortedEvents].reverse().find((event) => event.assigned_task)?.assigned_task || (key === "project_manager" ? selectedTask?.description || selectedTask?.title || "" : ""),
        ...timing,
        toolCount: sortedEvents.filter((event) => event.type === "tool_call").length,
        fileCount: paths.size,
        testCount: sortedEvents.filter((event) => event.type === "test_started").length,
        testFailed: sortedEvents.some((event) => event.type === "test_result" && event.status === "failed"),
        finalResult,
      };
    });
  }, [agents, taskEvents, selectedTask, currentStatus, now, settledAt]);
  const inspectorEvents = useMemo(() => {
    const matchesAgent = (event: EventRecord) => !selectedAgent || event.agent === selectedAgent || event.target === selectedAgent;
    if (selected) return workspaceView === "agent" ? taskEvents.filter(matchesAgent) : taskEvents;
    return events
      .filter((event) => (!project || event.project_name === project) && matchesAgent(event))
      .sort((a, b) => eventTime(a) - eventTime(b));
  }, [events, project, selected, selectedAgent, taskEvents, workspaceView]);
  const agentCards = useMemo<AgentCard[]>(() => agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => {
      const matchingEvents = (selected ? taskEvents : events.filter((event) => !project || event.project_name === project))
        .filter((event) => executionOwner(event) === agent.key)
        .sort((a, b) => eventTime(a) - eventTime(b));
      const latest = matchingEvents[matchingEvents.length - 1];
      const taskIds = new Set(matchingEvents.map((event) => rootTaskId(event.task_id)).filter(Boolean));
      const timing = executionTiming(matchingEvents, now, selected ? settledAt : undefined);
      return { agent, status: agentStatus(matchingEvents, selected ? currentStatus : undefined), latest, taskCount: taskIds.size, durationMs: timing.durationMs };
    }), [agents, events, project, selected, taskEvents, now, settledAt, currentStatus]);
  const projectStats = useMemo(() => ({
    taskCount: tasks.filter((task) => !project || task.project_name === project).length,
    eventCount: events.filter((event) => !project || event.project_name === project).length,
  }), [tasks, events, project]);
  const hasManagerCredentials = configuredCredentials.includes("FEISHU_PROJECT_MANAGER_APP_ID")
    && configuredCredentials.includes("FEISHU_PROJECT_MANAGER_APP_SECRET");

  useEffect(() => {
    let socket: DesktopSocket | null = null;
    let unsubscribe = () => {};
    // 重连（切换项目、归档/恢复历史后）要重新拉取任务记录；先回到“连接中”，ready 后再触发拉取。
    setTaskHistory({});
    historyRequests.current.clear();
    setConnection("连接中");
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
          const history = message.events || [];
          setTasks((current) => applyEventsToTasks(mergeTasks(current, message.tasks || []), history));
          if (history.length) setEvents((current) => mergeEvents(current, history));
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
        } else if (message.type === "command_result" && message.command === "task_events") {
          // 只读查询，不提示；失败时记为空，界面显示“暂无记录”而不是一直转圈。
          const taskId = historyRequests.current.get(message.requestId || "") || message.result?.taskId;
          historyRequests.current.delete(message.requestId || "");
          if (taskId) setTaskHistory((current) => ({ ...current, [taskId]: message.result?.events || [] }));
        } else if (message.type === "command_result") {
          if (message.command === "create_project") setCreatingProject(false);
          if (message.command === "create_project" && message.result?.projectName) {
            const created = message.result.projectName;
            setProjects((current) => current.includes(created) ? current : [...current, created].sort());
            setProject(created);
            setTaskProject(created);
            setProjectModalOpen(false);
            setProjectNameInput("");
            setProjectPathInput("");
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
          if (["pause", "resume", "terminate", "retry"].includes(message.command || "")) setPendingCommand(null);
          if (["export_project", "cleanup_history", "restore_history"].includes(message.command || "")) {
            setPendingProjectCommand(null);
            if (!message.error) setRefreshVersion((version) => version + 1);
          }
          const projectFeedback = formatProjectCommandFeedback(message.command, message.result);
          if (message.error) setNotice(`操作失败：${message.error}`);
          else if (projectFeedback) setNotice(projectFeedback);
          else if (message.command === "create_project") { /* 已在上方提示 */ }
          else setNotice(message.result?.taskId ? "任务已创建，正在连接项目经理…" : `${COMMAND_NAMES[message.command || ""] || "操作"}已受理`);
        } else if (message.type === "event" && message.event) {
          const event = message.event;
          setEvents((current) => mergeEvents(current, [event]));
          // 飞书端发起的任务也走同一个网关：出现新项目名时直接加入侧边栏，不必重连。
          const eventProject = event.project_name;
          if (eventProject) setProjects((current) => current.includes(eventProject) ? current : [...current, eventProject].sort());
          setTasks((current) => applyEventsToTasks(current, [event]));
        }
      });
    })().catch((error) => {
      setConnection("连接失败");
      setNotice(`无法连接本地任务服务：${String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")}`);
    });
    return () => {
      unsubscribe();
      if (activeSocket === socket) activeSocket = null;
      socket?.close();
    };
  }, [project, refreshVersion]);

  const refreshCredentials = () => {
    window.desktop?.credentials?.list?.().then(setConfiguredCredentials).catch(() => {});
    window.desktop?.credentials?.status?.().then(setCredentialStatus).catch(() => {});
  };
  useEffect(refreshCredentials, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openNewProjectConversation();
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
    if (!activeSocket || pendingProjectCommand) return;
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

  const openNewProject = () => {
    setProjectNameInput("");
    setProjectPathInput("");
    setProjectModalOpen(true);
    setNotice("");
  };

  const openNewProjectConversation = () => {
    const selectedProject = project || taskProject || projects[0] || "";
    if (!selectedProject) {
      setNotice("请先选择或新建一个项目");
      setWorkspaceView("project");
      return;
    }
    setSelected("");
    setSelectedAgent("");
    setWorkspaceView("conversation");
    setTaskProject(selectedProject);
    setTitle("");
    setDescription("");
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

  const scrollToAgent = (agentKey: string) => {
    setSelectedAgent(agentKey);
    setWorkspaceView("conversation");
    requestAnimationFrame(() => {
      const section = agentSectionRefs.current[agentKey];
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
      else setNotice("当前任务尚未产生该 Agent 的执行记录");
    });
  };
  const openEventFile = async (event: EventRecord) => {
    if (!event.file_path) return;
    if (!window.desktop?.openFile) { setNotice("请在桌面应用中打开交付文件"); return; }
    try {
      const result = await window.desktop.openFile(event.file_path, event.project_name || selectedTask?.project_name || project);
      if (!result.opened) setNotice(`文件无法打开：${result.error || event.file_path}`);
    } catch (error) { setNotice(`文件无法打开：${String(error)}`); }
  };
  const showSettings = () => {
    setWorkspaceView("settings");
    setSelected("");
    setSelectedAgent("");
    refreshCredentials();
  };
  const selectProject = (value: string) => {
    setProject(value);
    setSelected("");
    setSelectedAgent("");
    setTaskProject(value);
    setWorkspaceView("conversation");
  };

  const headerTitle = workspaceView === "settings" ? "运行设置"
    : workspaceView === "project" ? "项目上下文"
      : workspaceView === "agent" ? `${agents.find((agent) => agent.key === selectedAgent)?.displayName || selectedAgent || "全部 Agent"} · 执行观察`
        : selectedTask?.title || (selected ? selected : "新建任务");
  const headerSubtitle = workspaceView === "settings" ? "管理全部运行配置"
    : workspaceView === "project" ? project || "全部项目"
      : selectedTask?.project_name || project || "选择项目";

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        project={project}
        projects={projects}
        onSelectProject={selectProject}
        onRefresh={() => setRefreshVersion((version) => version + 1)}
        tasks={visibleTasks}
        selected={selected}
        selectedTask={selectedTask}
        onSelectTask={(taskId) => { setSelected(taskId); setSelectedAgent(""); setWorkspaceView("conversation"); }}
        pendingCommand={pendingCommand}
        onControl={sendControl}
        onObserve={() => { setSelectedAgent(""); setWorkspaceView("agent"); }}
        connection={connection}
        projectStats={projectStats}
        onOpenProject={() => { setWorkspaceView("project"); setSelected(""); setSelectedAgent(""); }}
        agents={agents}
        selectedAgent={selectedAgent}
        onObserveAgent={(agentKey) => { setSelectedAgent(agentKey); setWorkspaceView("agent"); }}
        onOpenSettings={showSettings}
        onNewProject={openNewProject}
        onNewConversation={openNewProjectConversation}
      />

      <section className="workspace">
        <header className="workspace-header">
          <div className="conversation-heading">
            {workspaceView !== "conversation" && <button className="workspace-back-button" onClick={() => { setWorkspaceView("conversation"); setSelectedAgent(""); }} aria-label="返回对话" title="返回对话">‹ <span>返回对话</span></button>}
            <div className="conversation-heading-copy"><h1>{headerTitle}</h1><span className="header-project">{headerSubtitle}</span></div>
          </div>
        </header>

        {notice && <div className="notice-bar" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
        {connection === "连接失败" && <div className="connection-alert" role="alert"><div><strong>本地任务服务暂不可用</strong><span>检查网关是否运行，或打开运行设置重新启动。</span></div><button className="quiet-button" onClick={showSettings}>打开运行设置</button></div>}
        {credentialStatus?.encryptionAvailable === false && workspaceView !== "settings" && <div className="connection-alert" role="alert"><div><strong>系统凭据加密不可用</strong><span>已保存的凭据无法读取，机器人不会启动。</span></div><button className="quiet-button" onClick={showSettings}>查看详情</button></div>}
        {!hasManagerCredentials && connection === "已连接" && <div className="setup-hint"><span>尚未配置项目经理凭据，任务暂时无法开始。</span><button onClick={showSettings}>配置凭据</button></div>}

        {workspaceView === "conversation" && <AgentStatusStrip cards={agentCards} selectedAgent={selectedAgent} onSelect={scrollToAgent} />}

        {workspaceView === "settings" && <SettingsView onSaved={refreshCredentials} onNotice={setNotice} />}
        {workspaceView === "project" && <ProjectView
          project={project}
          projects={projects}
          stats={projectStats}
          pendingCommand={pendingProjectCommand}
          onSelectProject={(value) => { setProject(value); setSelected(""); setSelectedAgent(""); }}
          onCommand={projectCommand}
        />}
        {workspaceView === "agent" && <AgentTraceView agents={agents} selectedAgent={selectedAgent} taskTitle={selected ? selectedTask?.title || selected : ""} events={inspectorEvents} onOpenFile={(event) => void openEventFile(event)} />}
        {workspaceView === "conversation" && <ConversationView
          selected={selected}
          selectedTask={selectedTask}
          project={project}
          agents={agents}
          selectedAgent={selectedAgent}
          taskEvents={taskEvents}
          taskEventsLoading={taskEventsLoading}
          groups={agentExecutionGroups}
          taskStartedAt={taskStartedAt}
          taskDuration={taskDuration}
          sectionRefs={agentSectionRefs}
          onOpenFile={(event) => void openEventFile(event)}
        />}

        {workspaceView === "conversation" && <Composer
          value={description}
          onChange={setDescription}
          onSubmit={submitTask}
          hasTask={Boolean(selectedTask)}
          canSubmit={Boolean(description.trim()) && Boolean(taskProject.trim()) && connection === "已连接"}
        />}
      </section>

      {projectModalOpen && <NewProjectModal
        name={projectNameInput}
        path={projectPathInput}
        creating={creatingProject}
        onNameChange={setProjectNameInput}
        onPathChange={setProjectPathInput}
        onChooseDirectory={() => void chooseProjectDirectory()}
        onSubmit={createProject}
        onClose={() => setProjectModalOpen(false)}
      />}
    </main>
  );
}
