import { randomUUID } from "node:crypto";
import { buildValidatedHandoff } from "./domain/delivery.js";
import { loadProjectSummaryFor } from "./gateway.js";
import { isTerminated } from "./tasks.js";

const DESKTOP_CHAT_ID = "desktop-local";

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function requireInput(input = {}) {
  const projectName = clean(input.projectName, 160);
  const description = clean(input.description, 8000);
  const title = clean(input.title, 240) || description.split(/\r?\n/, 1)[0].slice(0, 240);
  if (!projectName) throw new Error("projectName is required");
  if (!/^[a-z][a-z0-9-]*$/.test(projectName)) throw new Error("projectName must match ^[a-z][a-z0-9-]*$");
  if (!description) throw new Error("description is required");
  return { projectName, title, description };
}

/**
 * Desktop is another transport for the existing project-manager workflow.
 * It creates one durable root task and lets the orchestrator dispatch all
 * downstream work; it never sends Feishu cards for a desktop-originated task.
 */
export function createDesktopTaskSubmitter({
  taskStore,
  orchestrator,
  runAgent,
  projectManagerAgent,
  recordEvent = async () => {},
  loadProjectSummary = loadProjectSummaryFor,
  idFactory = randomUUID,
} = {}) {
  if (!taskStore?.create) throw new TypeError("desktop task submitter requires taskStore");
  if (!orchestrator?.onTaskCompleted) throw new TypeError("desktop task submitter requires orchestrator");
  if (typeof runAgent !== "function") throw new TypeError("desktop task submitter requires runAgent");

  const background = new Set();
  const track = (promise) => {
    const tracked = Promise.resolve(promise).finally(() => background.delete(tracked));
    background.add(tracked);
    return tracked;
  };

  async function execute(task, input, messageId) {
    const projectName = input.projectName;
    const onEvent = (event) => recordEvent({
      ...event,
      task_id: event.task_id || task.task_id,
      project_name: event.project_name || projectName,
      chat_id: event.chat_id || DESKTOP_CHAT_ID,
      channel: "desktop",
    });
    try {
      await onEvent({ type: "task_started", task_id: task.task_id, agent: "project_manager" });
      const projectSummary = await loadProjectSummary("project_manager", projectName);
      const prompt = [
        `任务标题：${input.title}`,
        `项目：${projectName}`,
        `任务描述：${input.description}`,
        "请先作为项目经理完成任务规划，再按计划分配可并行的阶段任务。",
      ].join("\n");
      const result = await runAgent(projectManagerAgent, prompt, {
        taskId: task.task_id,
        chatId: DESKTOP_CHAT_ID,
        messageId,
        correlationId: messageId,
        channel: "desktop",
        projectName,
        projectSummary,
        requireHumanApproval: false,
        onEvent,
      });
      if (result?.cancelled || await isTerminated(task.task_id)) {
        await onEvent({ type: "task_cancelled", task_id: task.task_id, agent: "project_manager" });
        return { cancelled: true };
      }
      const reportedProject = result?.projectName || result?.delivery?.projectName || projectName;
      if (reportedProject !== projectName) throw new Error("项目经理交付的项目与桌面任务所选项目不一致");
      const delivery = result?.delivery || {
        agentKey: "project_manager",
        agentName: projectManagerAgent.displayName,
        summary: result?.text || "项目经理未返回结构化交付",
        artifactPaths: [],
        next: "无需后续操作",
        final: false,
      };
      if (!String(delivery.next || delivery.next_action || "").trim()) delivery.next = delivery.final ? "无需后续操作" : "继续执行当前计划";
      await buildValidatedHandoff(delivery, { agentKey: "project_manager", taskId: task.task_id });
      await orchestrator.onTaskCompleted("project_manager", task.task_id, {
        delivery,
        resultText: result?.text,
        context: {
          chatId: DESKTOP_CHAT_ID,
          messageId,
          correlationId: messageId,
          channel: "desktop",
          requireHumanApproval: false,
          projectName,
        },
        approvalRequired: false,
      });
      await onEvent({
        type: "task_completed",
        task_id: task.task_id,
        agent: "project_manager",
        project_name: projectName,
        has_delivery: Boolean(result?.delivery),
        artifact_count: delivery.artifactPaths?.length || 0,
        final: delivery.final === true,
      });
      return { taskId: task.task_id, delivery };
    } catch (error) {
      await onEvent({ type: "task_failed", task_id: task.task_id, agent: "project_manager", error: error.message });
      throw error;
    }
  }

  async function submitTask(input = {}) {
    if (!projectManagerAgent?.key) throw new Error("project_manager agent is unavailable");
    const normalized = requireInput(input);
    const messageId = clean(input.messageId || input.requestId, 160) || `desktop-${idFactory()}`;
    const idempotencyKey = clean(input.idempotencyKey, 240) || `desktop:${messageId}`;
    const existing = await taskStore.findByIdempotencyKey?.(idempotencyKey);
    if (existing) return { taskId: existing.task_id, status: "accepted", projectName: existing.project_name, title: existing.title, duplicate: true };
    const task = await taskStore.create({
      agent: "project_manager",
      requested_role: "project_manager",
      source_chat_id: DESKTOP_CHAT_ID,
      source_message_id: messageId,
      root_key: messageId,
      idempotency_key: idempotencyKey,
      project_name: normalized.projectName,
      title: normalized.title,
      description: normalized.description,
    });
    await recordEvent({
      type: "task_created",
      task_id: task.task_id,
      agent: "project_manager",
      chat_id: DESKTOP_CHAT_ID,
      message_id: messageId,
      project_name: normalized.projectName,
      channel: "desktop",
      title: normalized.title,
      text: normalized.description.slice(0, 200),
    });
    track(execute(task, normalized, messageId)).catch(() => {});
    return { taskId: task.task_id, status: "accepted", projectName: normalized.projectName, title: normalized.title };
  }

  submitTask.whenIdle = async () => { while (background.size) await Promise.allSettled([...background]); };
  return submitTask;
}

export { DESKTOP_CHAT_ID };
