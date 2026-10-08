import { createDesktopControlServer } from "./desktop-control.js";

const rootOf = (taskId) => String(taskId || "").split(":")[0];

export function createDesktopHost({ token, eventsFile, taskStore, orchestrator, recordEvent, agents, submitTask, createProject, listProjects, exportProject, cleanupHistory, restoreHistory, host, port } = {}) {
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
    async retry({ taskId, error }) {
      const id = rootOf(taskId);
      if (!id || typeof taskStore.retry !== "function") throw new Error("task retry is unavailable");
      const retried = await taskStore.retry(id, error);
      if (!retried) throw new Error("task not found");
      if (retried.status !== "retrying") return { retried: false, status: retried.status, attempt: retried.attempt };
      const resumed = typeof orchestrator.resumeTask === "function" ? await orchestrator.resumeTask(id) : 0;
      await recordEvent?.({ type: "control_applied", task_id: id, command: "retry", result: "retrying" });
      return { retried: true, resumed, attempt: retried.attempt };
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
  };
  const server = createDesktopControlServer({ token, eventsFile, taskStore, agents, commandHandlers, listProjects, host, port });
  return { ...server, commandHandlers };
}
