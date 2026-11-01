import { createDesktopControlServer } from "./desktop-control.js";
import { forEachEvent } from "../domain/event-log.js";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const rootOf = (taskId) => String(taskId || "").split(":")[0];

// 项目作用域连接只能操作本项目的工单源：请求带的 projectName 必须与工单源的项目一致。
async function scopedSource(tickets, { sourceId, projectName }) {
  const source = (await tickets.listSources()).find((item) => item.id === sourceId);
  if (!source) throw new Error("找不到这个工单源");
  if (projectName && source.project !== projectName) throw new Error("工单源不属于当前项目");
  return source;
}

export function createDesktopHost({ token, eventsFile, taskStore, orchestrator, recordEvent, agents, submitTask, createProject, listProjects, listProjectRoots, exportProject, cleanupHistory, restoreHistory, tickets = null, capabilities = null, customAgents = null, runtimeConfig = null, mcp = null, host, port } = {}) {
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
  const requireMcp = () => {
    if (!mcp) throw new Error("MCP 功能不可用");
    return mcp;
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
    async memory_list({ projectName } = {}) {
      const tasks = await taskStore.list();
      const scoped = projectName ? tasks.filter((task) => task?.project_name === projectName) : tasks;
      const items = scoped.flatMap((task) => (Array.isArray(task?.conversation_memory) ? task.conversation_memory : [])
        .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim())
        .map((entry, index) => ({
          id: `${task.task_id}:${index}`,
          taskId: task.task_id,
          projectName: task.project_name || null,
          taskTitle: task.title || String(task.description || "").split(/\r?\n/, 1)[0].slice(0, 240) || task.task_id,
          role: entry.role === "assistant" ? "assistant" : "user",
          text: String(entry.text).slice(0, 3000),
          at: entry.at || task.updated_at || task.created_at || null,
          confirmed: entry.confirmed === true,
        })))
        .sort((left, right) => Date.parse(right.at || "") - Date.parse(left.at || ""));
      return { items: items.slice(0, 1000) };
    },
    async memory_update({ taskId, id, text, confirmed } = {}) {
      const task = await taskStore.getRoot?.(taskId) || await taskStore.get?.(rootOf(taskId));
      const index = Number(String(id || "").split(":").at(-1));
      if (!task || !Number.isInteger(index) || index < 0 || !task.conversation_memory?.[index] || typeof task.conversation_memory[index] !== "object") throw new Error("找不到这条记忆");
      const memory = [...task.conversation_memory];
      const entry = { ...memory[index] };
      if (text !== undefined) {
        const nextText = String(text || "").trim().slice(0, 3000);
        if (!nextText) throw new Error("记忆内容不能为空");
        entry.text = nextText;
      }
      if (confirmed !== undefined) entry.confirmed = confirmed === true;
      memory[index] = entry;
      await taskStore.update(task.task_id, { conversation_memory: memory });
      return { updated: true };
    },
    async memory_delete({ taskId, id } = {}) {
      const task = await taskStore.getRoot?.(taskId) || await taskStore.get?.(rootOf(taskId));
      const index = Number(String(id || "").split(":").at(-1));
      if (!task || !Number.isInteger(index) || index < 0 || index >= (task.conversation_memory?.length || 0)) throw new Error("找不到这条记忆");
      const memory = task.conversation_memory.filter((_, position) => position !== index);
      await taskStore.update(task.task_id, { conversation_memory: memory });
      return { deleted: true };
    },
    // Read-only projection over the append-only event log. It never opens or mutates files.
    async workspace_files({ projectName } = {}) {
      const tasks = await taskStore.list();
      const taskProjects = new Map(tasks.map((task) => [task.task_id, task.project_name]));
      const files = new Map();
      await forEachEvent(eventsFile, (event) => {
        const rootTaskId = rootOf(event.task_id || event.parent_task_id);
        const eventProject = event.project_name || taskProjects.get(rootTaskId) || null;
        if (projectName && eventProject !== projectName) return;
        const artifactItems = new Map((Array.isArray(event.artifact_items) ? event.artifact_items : [])
          .filter((item) => item?.path)
          .map((item) => [String(item.path).replaceAll("\\", "/"), item]));
        const paths = [
          ...(event.file_path ? [event.file_path] : []),
          ...(Array.isArray(event.artifact_paths) ? event.artifact_paths : []),
          ...(Array.isArray(event.artifact_items) ? event.artifact_items.map((item) => item?.path) : []),
          ...(Array.isArray(event.evidence) ? event.evidence.filter((item) => ["file", "screenshot"].includes(item?.kind)).map((item) => item.path) : []),
        ].filter(Boolean);
        for (const path of paths) {
          const normalized = String(path).replaceAll("\\", "/");
          const key = `${eventProject || ""}:${normalized}`;
          const item = artifactItems.get(normalized);
          const previous = files.get(key);
          files.set(key, {
            path: normalized,
            projectName: eventProject,
            taskId: rootTaskId || null,
            eventType: event.type || null,
            description: item?.description || previous?.description || event.summary || "",
            size: Number.isFinite(item?.size) ? item.size : previous?.size,
            timestamp: event.timestamp || previous?.timestamp || null,
          });
        }
      });
      if (typeof listProjectRoots === "function") {
        const roots = await listProjectRoots(projectName);
        let projectFileCount = 0;
        for (const project of roots || []) {
          if (projectFileCount >= 5000) break;
          if (!project.storagePath) continue;
          const root = resolve(String(project.storagePath));
          const walk = async (dir) => {
            let entries;
            try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
              if (projectFileCount >= 5000) return;
              if (entry.name === ".git" || entry.name === "node_modules") continue;
              const absolute = resolve(dir, entry.name);
              if (entry.isDirectory()) await walk(absolute);
              else if (entry.isFile()) {
                const rel = relative(root, absolute).replaceAll("\\", "/");
                const path = `workspace/${project.name}/${rel}`;
                const key = `${project.name}:${path}`;
                const info = await stat(absolute).catch(() => null);
                if (!files.has(key)) files.set(key, { path, projectName: project.name, taskId: null, eventType: "directory_listing", description: "项目目录中的文件", size: info?.size, timestamp: info?.mtime?.toISOString() || null });
                projectFileCount += 1;
              }
            }
          };
          if (root) await walk(root);
        }
      }
      return {
        files: [...files.values()]
          .sort((left, right) => Date.parse(right.timestamp || "") - Date.parse(left.timestamp || ""))
          .slice(0, 1000),
      };
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
    async mcp_list() { return requireMcp().list(); },
    async mcp_save(input = {}) {
      const server = await requireMcp().save(input);
      await recordEvent?.({ type: "mcp_server_saved", server_id: server.id, channel: "desktop" });
      return { server };
    },
    async mcp_set_enabled({ id, enabled } = {}) {
      const server = await requireMcp().setEnabled(id, enabled === true);
      await recordEvent?.({ type: "mcp_server_toggled", server_id: server.id, enabled: server.enabled, channel: "desktop" });
      return { server };
    },
    async mcp_reconnect({ id } = {}) { return { server: await requireMcp().connect(id) }; },
    async mcp_remove({ id } = {}) { return requireMcp().remove(id); },
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
