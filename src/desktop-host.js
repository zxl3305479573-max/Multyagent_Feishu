import { createDesktopControlServer } from "./desktop-control.js";

const rootOf = (taskId) => String(taskId || "").split(":")[0];

// 项目作用域连接只能操作本项目的工单源：请求带的 projectName 必须与工单源的项目一致。
async function scopedSource(tickets, { sourceId, projectName }) {
  const source = (await tickets.listSources()).find((item) => item.id === sourceId);
  if (!source) throw new Error("找不到这个工单源");
  if (projectName && source.project !== projectName) throw new Error("工单源不属于当前项目");
  return source;
}

export function createDesktopHost({ token, eventsFile, taskStore, orchestrator, recordEvent, agents, submitTask, createProject, listProjects, exportProject, cleanupHistory, restoreHistory, tickets = null, capabilities = null, customAgents = null, runtimeConfig = null, host, port } = {}) {
  const requireCapabilities = () => {
    if (!capabilities) throw new Error("能力管理不可用");
    return capabilities;
  };
  const requireCustomAgents = () => {
    if (!customAgents) throw new Error("自定义 Agent 功能不可用");
    return customAgents;
  };
  const requireTickets = () => {
    if (!tickets) throw new Error("工单功能不可用（需要启用项目经理）");
    return tickets;
  };
  const requireRuntimeConfig = () => {
    if (!runtimeConfig) throw new Error("模型切换不可用");
    return runtimeConfig;
  };
  if (!taskStore || !orchestrator) throw new TypeError("desktop host requires taskStore and orchestrator");
  const commandHandlers = {
    async pause({ taskId }) {
      const id = rootOf(taskId);
      const task = id ? await taskStore.setPaused(id, true) : null;
      if (!task) throw new Error("task not found");
      await recordEvent?.({ type: "control_applied", task_id: id, command: "pause", result: "paused" });
      return { paused: true };
    },
    async resume({ taskId }) {
      const id = rootOf(taskId);
      const resumed = id ? await orchestrator.resumeTask(id) : null;
      if (resumed === null) throw new Error("task not found");
      await recordEvent?.({ type: "control_applied", task_id: id, command: "resume", result: "resumed" });
      return { resumed };
    },
    async terminate({ taskId }) {
      const id = rootOf(taskId);
      const task = id && (taskStore.get ? await taskStore.get(id) : (await taskStore.list?.())?.find((item) => item.task_id === id));
      if (!task) throw new Error("task not found");
      const outcome = await orchestrator.terminateTask(id);
      await recordEvent?.({ type: "control_applied", task_id: id, command: "terminate", result: outcome.terminated ? "terminated" : "not_terminated" });
      return outcome;
    },
    // 重试 = 把失败任务连同失败原因交回项目经理重新决策，而不是重放失败的派发。
    async retry({ taskId, error }) {
      const id = rootOf(taskId);
      if (!id || typeof orchestrator.retryTask !== "function") throw new Error("task retry is unavailable");
      const outcome = await orchestrator.retryTask(id, { error });
      if (!outcome) throw new Error("task not found");
      if (!outcome.retried) return outcome;
      await recordEvent?.({ type: "control_applied", task_id: id, command: "retry", result: "retrying" });
      return outcome;
    },
    async submit_task(input) {
      if (typeof submitTask !== "function") throw new Error("desktop task submission is unavailable");
      return submitTask(input || {});
    },
    async continue_task(input = {}) {
      if (typeof submitTask?.continueTask !== "function") throw new Error("desktop task continuation is unavailable");
      return submitTask.continueTask(input);
    },
    // 规划模式的确认：taskId 是 approval_required 事件里的任务编号（可能是子任务）。
    async approve_task({ taskId, choice = "approve" } = {}) {
      if (typeof orchestrator.resolveLatest !== "function") throw new Error("task approval is unavailable");
      const id = String(taskId || "").trim();
      if (!id) throw new Error("taskId is required");
      const resolved = await orchestrator.resolveLatest("desktop-local", String(choice || "approve"), id);
      if (!resolved) throw new Error("这个任务当前没有等待确认的内容");
      await recordEvent?.({ type: "control_applied", task_id: rootOf(id), command: "approve", result: "approved", choice: String(choice || "approve") });
      return { approved: true, agentKey: resolved.agentKey };
    },
    async create_project(input) {
      if (typeof createProject !== "function") throw new Error("project creation is unavailable");
      return createProject(input || {});
    },
    async export_project(input) {
      if (typeof exportProject !== "function") throw new Error("project export is unavailable");
      return exportProject(input || {});
    },
    async cleanup_history(input) {
      if (typeof cleanupHistory !== "function") throw new Error("history cleanup is unavailable");
      return cleanupHistory(input || {});
    },
    async restore_history(input) {
      if (typeof restoreHistory !== "function") throw new Error("history restore is unavailable");
      return restoreHistory(input || {});
    },
    async runtime_config({ provider } = {}) {
      return requireRuntimeConfig().get({ provider });
    },
    async runtime_config_set(input = {}) {
      const result = await requireRuntimeConfig().set(input);
      await recordEvent?.({
        type: "runtime_model_changed",
        provider: result.provider,
        model: result.model,
        thinking: result.thinking,
        channel: "desktop",
      });
      return result;
    },
    async capabilities_list() {
      return requireCapabilities().list();
    },
    async capabilities_install({ kind, source, trustPlugin, roles } = {}) {
      const installed = await requireCapabilities().install({ kind, source, trustPlugin, roles });
      await recordEvent?.({ type: "capability_installed", kind, name: installed.name, source: installed.source, roles: installed.roles, channel: "desktop" });
      return { capability: installed };
    },
    async capabilities_assign({ kind, name, roles, enabled, local = false, path } = {}) {
      const updated = await requireCapabilities().assign({ kind, name, roles, enabled, local: local === true, path });
      await recordEvent?.({ type: "capability_updated", kind, name: updated.name, local: local === true, roles: updated.roles, enabled: updated.enabled, channel: "desktop" });
      return { capability: updated };
    },
    async capabilities_base_assign({ agentKey, tool, enabled } = {}) {
      const updated = await requireCapabilities().assignBase({ agentKey, tool, enabled: enabled === true });
      await recordEvent?.({ type: "capability_base_updated", agent: updated.agentKey, capability: updated.name, enabled: updated.enabled, channel: "desktop" });
      return { capability: updated };
    },
    async capabilities_remove({ kind, name } = {}) {
      const result = await requireCapabilities().remove({ kind, name });
      await recordEvent?.({ type: "capability_removed", kind, name, channel: "desktop" });
      return result;
    },
    // 自定义 Agent：保存后需重启服务才会加载（角色配置在启动时校验）。
    async custom_agents_list() {
      return requireCustomAgents().list();
    },
    async custom_agents_design(input = {}) {
      return requireCustomAgents().design({ requirement: input.requirement, triggers: input.triggers, displayName: input.displayName, current: input.current || null, originalKey: input.originalKey || "" });
    },
    async custom_agents_save({ role, originalKey = "" } = {}) {
      const result = await requireCustomAgents().save({ role, originalKey });
      await recordEvent?.({ type: "custom_agent_saved", agent: result.role.key, renamed_from: originalKey && originalKey !== result.role.key ? originalKey : null, channel: "desktop" });
      return result;
    },
    async custom_agents_remove({ key } = {}) {
      const result = await requireCustomAgents().remove({ key });
      await recordEvent?.({ type: "custom_agent_removed", agent: key, channel: "desktop" });
      return result;
    },
    async tickets_sources({ projectName } = {}) {
      const service = requireTickets();
      return { sources: await service.listSources({ project: projectName || "" }), hasToken: service.hasToken() };
    },
    async tickets_save_source({ projectName, source } = {}) {
      if (projectName && source?.project !== projectName) throw new Error("工单源不属于当前项目");
      return { source: await requireTickets().saveSource(source || {}) };
    },
    async tickets_remove_source(input = {}) {
      await scopedSource(requireTickets(), input);
      return requireTickets().removeSource(input.sourceId);
    },
    async tickets_inbox(input = {}) {
      await scopedSource(requireTickets(), input);
      return requireTickets().inbox({ sourceId: input.sourceId });
    },
    async tickets_dispatch(input = {}) {
      await scopedSource(requireTickets(), input);
      return requireTickets().dispatch({ sourceId: input.sourceId, number: Number(input.number), note: String(input.note || ""), origin: "desktop" });
    },
    async tickets_pull(input = {}) {
      await scopedSource(requireTickets(), input);
      return requireTickets().pull(input.sourceId, { reason: "manual" });
    },
  };
  const server = createDesktopControlServer({ token, eventsFile, taskStore, agents, commandHandlers, listProjects, host, port });
  return { ...server, commandHandlers };
}
