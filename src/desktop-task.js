import { randomUUID } from "node:crypto";
import { buildValidatedHandoff } from "./domain/delivery.js";
import { loadProjectSummaryFor } from "./gateway.js";
import { isTerminated } from "./tasks.js";
import { ASK_TOOL_ALLOWLIST, applyModeToDelivery, modeInstruction, normalizeModes } from "./desktop-modes.js";

const DESKTOP_CHAT_ID = "desktop-local";

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function withMemory(memory, role, text) {
  const content = clean(text, 3000);
  if (!content) return Array.isArray(memory) ? memory : [];
  return [...(Array.isArray(memory) ? memory : []), { role, text: content, at: new Date().toISOString() }].slice(-40);
}

function formatMemory(memory) {
  return (Array.isArray(memory) ? memory : [])
    .map((item) => `${item.role === "assistant" ? "项目经理" : "用户"}：${item.text}`)
    .join("\n");
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
  // 可单独交付任务的角色（输入框“协作对象”选择某个机器人时使用）。
  agents = [],
  recordEvent = async () => {},
  loadProjectSummary = loadProjectSummaryFor,
  idFactory = randomUUID,
} = {}) {
  if (!taskStore?.create) throw new TypeError("desktop task submitter requires taskStore");
  if (!orchestrator?.onTaskCompleted) throw new TypeError("desktop task submitter requires orchestrator");
  if (typeof runAgent !== "function") throw new TypeError("desktop task submitter requires runAgent");

  const background = new Set();
  const continuationTasks = new Set();
  const roleAgents = new Map(agents.filter((agent) => agent?.key && agent.key !== "project_manager").map((agent) => [agent.key, agent]));
  const agentFor = (target) => (target && target !== "team" ? roleAgents.get(target) : null) || projectManagerAgent;
  // 任务记录里保存的模式：续聊默认沿用，输入框改了则以本轮为准。
  const storedModes = (task) => ({ ...(task?.desktop_mode || {}), ...(task?.runtime ? { runtime: task.runtime } : {}) });
  const track = (promise) => {
    const tracked = Promise.resolve(promise).finally(() => background.delete(tracked));
    background.add(tracked);
    return tracked;
  };

  async function execute(task, input, messageId, { followUp = false, modes = normalizeModes() } = {}) {
    const projectName = input.projectName;
    const agent = agentFor(modes.target);
    const singleRole = agent.key !== "project_manager";
    const storedTask = followUp && typeof taskStore.getRoot === "function" ? await taskStore.getRoot(task.task_id) : task;
    const sessionFile = storedTask?.session_file || null;
    const memory = formatMemory(storedTask?.conversation_memory);
    const onEvent = (event) => recordEvent({
      ...event,
      task_id: event.task_id || task.task_id,
      project_name: event.project_name || projectName,
      chat_id: event.chat_id || DESKTOP_CHAT_ID,
      channel: "desktop",
    });
    try {
      if (followUp) {
        await onEvent({
          type: "task_reused",
          task_id: task.task_id,
          agent: "project_manager",
          text: input.description,
          project_name: projectName,
        });
      }
      await onEvent({ type: "task_started", task_id: task.task_id, agent: agent.key, mode: modes.mode, runtime: modes.runtime || undefined });
      const projectSummary = await loadProjectSummary(agent.key, projectName);
      const prompt = followUp
        ? [
          `这是同一任务 ${task.task_id} 的后续对话，请沿用此前会话、交付和项目上下文。`,
          `任务标题：${input.title}`,
          `项目：${projectName}`,
          `用户后续消息：${input.description}`,
          memory ? `此前对话记忆：\n${memory}` : "",
          "请直接回应用户的新要求；只有确实需要协作时才重新派发角色，不要新建任务。",
          projectSummary?.content ? `项目历史摘要：\n${projectSummary.content}` : "",
        ].filter(Boolean).join("\n")
        : [
          `任务标题：${input.title}`,
          `项目：${projectName}`,
          `任务描述：${input.description}`,
          singleRole ? `用户把这项工作直接交给你（${agent.displayName || agent.key}）处理。` : "请先作为项目经理完成任务规划，再按计划分配可并行的阶段任务。",
        ].join("\n");
      const instruction = modeInstruction(modes.mode, singleRole);
      const result = await runAgent(agent, instruction ? `${prompt}\n${instruction}` : prompt, {
        taskId: task.task_id,
        chatId: DESKTOP_CHAT_ID,
        messageId,
        correlationId: messageId,
        channel: "desktop",
        projectName,
        projectSummary,
        requireHumanApproval: false,
        ...(modes.runtime ? { runtime: modes.runtime } : {}),
        // 问答模式：只开放读取类工具，写文件、执行命令都会被策略闸门拦下。
        ...(modes.mode === "ask" ? { taskPermissions: { toolAllowlist: ASK_TOOL_ALLOWLIST } } : {}),
        onEvent,
      }, { sessionFile });
      if (typeof taskStore.update === "function") {
        const latest = typeof taskStore.getRoot === "function" ? await taskStore.getRoot(task.task_id) : task;
        await taskStore.update(task.task_id, {
          ...(result?.sessionFile ? { session_file: result.sessionFile } : {}),
          conversation_memory: withMemory(latest?.conversation_memory || task.conversation_memory, "assistant", result?.delivery?.summary || result?.text || "本轮执行已完成"),
        });
      }
      if (result?.cancelled || await isTerminated(task.task_id)) {
        await onEvent({ type: "task_cancelled", task_id: task.task_id, agent: "project_manager" });
        return { cancelled: true };
      }
      const reportedProject = result?.projectName || result?.delivery?.projectName || projectName;
      if (reportedProject !== projectName) throw new Error("项目经理交付的项目与桌面任务所选项目不一致");
      const delivered = result?.delivery || {
        agentKey: agent.key,
        agentName: agent.displayName,
        summary: result?.text || "项目经理未返回结构化交付",
        artifactPaths: [],
        next: "无需后续操作",
        final: false,
      };
      const delivery = applyModeToDelivery(delivered, modes.mode);
      if (singleRole && modes.mode === "plan" && !String(delivery.next || "").trim()) delivery.next = "按上述方案执行";
      if (!String(delivery.next || delivery.next_action || "").trim() && delivery.final === true) delivery.next = "无需后续操作";
      await buildValidatedHandoff(delivery, { agentKey: agent.key, taskId: task.task_id });
      await orchestrator.onTaskCompleted(agent.key, task.task_id, {
        delivery,
        resultText: result?.text,
        context: {
          chatId: DESKTOP_CHAT_ID,
          messageId,
          correlationId: messageId,
          channel: "desktop",
          // 团队任务统一在项目经理产出计划后等待确认；单个机器人仅在规划模式下等待确认。
          requireHumanApproval: modes.mode !== "ask" && (!singleRole || modes.mode === "plan"),
          projectName,
          ...(modes.runtime ? { runtime: modes.runtime } : {}),
          ...(singleRole ? { singleRole: true } : {}),
        },
        approvalRequired: singleRole && modes.mode === "plan",
      });
      await onEvent({
        type: "task_completed",
        task_id: task.task_id,
        agent: agent.key,
        project_name: projectName,
        has_delivery: Boolean(result?.delivery),
        artifact_count: delivery.artifactPaths?.length || 0,
        final: delivery.final === true,
      });
      return { taskId: task.task_id, delivery };
    } catch (error) {
      await onEvent({ type: "task_failed", task_id: task.task_id, agent: agent.key, error: error.message });
      throw error;
    }
  }

  async function submitTask(input = {}) {
    if (!projectManagerAgent?.key) throw new Error("project_manager agent is unavailable");
    const normalized = requireInput(input);
    const modes = normalizeModes(input, { roleKeys: [...roleAgents.keys()] });
    const owner = agentFor(modes.target).key;
    const messageId = clean(input.messageId || input.requestId, 160) || `desktop-${idFactory()}`;
    const idempotencyKey = clean(input.idempotencyKey, 240) || `desktop:${messageId}`;
    const existing = await taskStore.findByIdempotencyKey?.(idempotencyKey);
    if (existing) return { taskId: existing.task_id, status: "accepted", projectName: existing.project_name, title: existing.title, duplicate: true };
    const task = await taskStore.create({
      agent: owner,
      requested_role: owner,
      runtime: modes.runtime,
      desktop_mode: { mode: modes.mode, target: modes.target },
      source_chat_id: DESKTOP_CHAT_ID,
      source_message_id: messageId,
      root_key: messageId,
      idempotency_key: idempotencyKey,
      project_name: normalized.projectName,
      title: normalized.title,
      description: normalized.description,
      conversation_memory: withMemory([], "user", normalized.description),
    });
    await recordEvent({
      type: "task_created",
      task_id: task.task_id,
      agent: owner,
      mode: modes.mode,
      target: modes.target,
      runtime: modes.runtime || undefined,
      chat_id: DESKTOP_CHAT_ID,
      message_id: messageId,
      project_name: normalized.projectName,
      channel: "desktop",
      title: normalized.title,
      text: normalized.description.slice(0, 200),
    });
    track(execute(task, normalized, messageId, { modes })).catch(() => {});
    return { taskId: task.task_id, status: "accepted", projectName: normalized.projectName, title: normalized.title, mode: modes.mode, target: modes.target, runtime: modes.runtime };
  }

  async function continueTask(input = {}) {
    if (!projectManagerAgent?.key) throw new Error("project_manager agent is unavailable");
    const taskId = clean(input.taskId, 160);
    const description = clean(input.message || input.description, 8000);
    if (!taskId) throw new Error("taskId is required");
    if (!description) throw new Error("message is required");
    if (continuationTasks.has(taskId)) throw new Error("当前任务已有一条后续消息正在处理");
    const task = typeof taskStore.getRoot === "function" ? await taskStore.getRoot(taskId) : await taskStore.get(taskId);
    if (!task) throw new Error("task not found");
    const owner = task.agent || task.requested_role;
    if (owner && owner !== "project_manager" && !roleAgents.has(owner)) throw new Error("这个任务不支持继续对话");
    const status = task.status_snapshot?.status || task.status;
    if (status === "in_progress") throw new Error("当前任务仍在执行，请等待本轮完成后再继续");
    if (status === "awaiting_approval") throw new Error("当前任务正在等待确认，请先处理确认项");
    if (task.terminated || status === "cancelled") throw new Error("已终止的任务不能继续");
    if (typeof orchestrator.reopenTask !== "function") throw new Error("任务续聊不可用");
    const reopened = await orchestrator.reopenTask(taskId);
    if (!reopened?.reopened) throw new Error(reopened?.reason || "任务无法继续");
    const messageId = clean(input.messageId || input.requestId, 160) || `desktop-${idFactory()}`;
    if (typeof taskStore.update === "function") {
      const priorMemory = task.conversation_memory?.length
        ? task.conversation_memory
        : withMemory([], "user", task.description || task.title);
      await taskStore.update(taskId, { conversation_memory: withMemory(priorMemory, "user", description), last_message_id: messageId });
    }
    const normalized = {
      projectName: task.project_name,
      title: task.title || String(task.description || "").split(/\r?\n/, 1)[0].slice(0, 240),
      description,
    };
    // 续聊沿用任务的协作对象；执行模式和运行方式以本轮输入框的选择为准（未传则沿用上次）。
    const previous = storedModes(task);
    const modes = normalizeModes({
      mode: input.mode ?? previous.mode,
      runtime: input.runtime ?? previous.runtime,
      target: owner && owner !== "project_manager" ? owner : "team",
    }, { roleKeys: [...roleAgents.keys()] });
    if (typeof taskStore.update === "function") await taskStore.update(taskId, { runtime: modes.runtime, desktop_mode: { mode: modes.mode, target: modes.target } });
    continuationTasks.add(taskId);
    const execution = execute(task, normalized, messageId, { followUp: true, modes }).finally(() => continuationTasks.delete(taskId));
    track(execution).catch(() => {});
    return { taskId, status: "accepted", projectName: task.project_name, title: normalized.title, continued: true };
  }

  submitTask.whenIdle = async () => { while (background.size) await Promise.allSettled([...background]); };
  submitTask.continueTask = continueTask;
  return submitTask;
}

export { DESKTOP_CHAT_ID };
