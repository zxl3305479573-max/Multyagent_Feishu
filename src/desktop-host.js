import { createDesktopControlServer } from "./desktop-control.js";

const rootOf = (taskId) => String(taskId || "").split(":")[0];

// 项目作用域连接只能操作本项目的工单源：请求带的 projectName 必须与工单源的项目一致。
async function scopedSource(tickets, { sourceId, projectName }) {
  const source = (await tickets.listSources()).find((item) => item.id === sourceId);
  if (!source) throw new Error("找不到这个工单源");
  if (projectName && source.project !== projectName) throw new Error("工单源不属于当前项目");
  return source;
}

export function createDesktopHost({ token, eventsFile, taskStore, orchestrator, recordEvent, agents, submitTask, createProject, listProjects, exportProject, cleanupHistory, restoreHistory, tickets = null, host, port } = {}) {
  const requireTickets = () => {
    if (!tickets) throw new Error("工单功能不可用（需要启用项目经理）");
    return tickets;
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
