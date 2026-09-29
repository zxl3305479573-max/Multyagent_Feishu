// Orchestration and role dispatch.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { buildTaskReceivedCard, sendCard, sendResultCard, sendText } from "./gateway.js";
import { isPaused, isTerminated, setPaused, setTerminated } from "./tasks.js";
import { artifactsDirFor } from "./artifacts.js";
import { abortActiveSessions } from "./session-control.js";

const routesConfig = JSON.parse(
  await readFile(new URL("../config/routes.json", import.meta.url), "utf8"),
);

const MAX_DISPATCH_ROUNDS = Number(process.env.PI_MAX_DISPATCH_ROUNDS) || 8;

export function matchRoutes(routes, agentKey) {
  const matched = [];
  for (const rule of routes) {
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from];
    if (!froms.includes(agentKey)) continue;
    matched.push({
      froms,
      tos: Array.isArray(rule.to) ? rule.to : [rule.to],
      when: rule.when || "always",
    });
  }
  return matched;
}

export function createOrchestrator({
  runAgent,
  log = console,
  maxRounds = MAX_DISPATCH_ROUNDS,
  onEvent = async () => {},
  // 传了路径才落盘：待确认项必须能跨重启存活，否则重启前发出的卡片一律点不动。
  approvalsFile = null,
  checkpointFile = null,
  approvalTtlMs = Number(process.env.PI_APPROVAL_TTL_MS) || 24 * 60 * 60 * 1000,
}) {
  const roles = new Map(); // agentKey -> { agent, client }
  const dispatchGroups = new Map(); // 姹囪仛灞忛殰鐘舵€侊細groupKey -> Set(宸插畬鎴愮殑瑙掕壊)
  const rootRounds = new Map();
  const deliveryHistory = new Map();
  const approvals = new Map(restoreApprovals());
  const checkpoints = new Map(restoreCheckpoints());
  const background = new Set();

  function restoreApprovals() {
    if (!approvalsFile) return [];
    try {
      const raw = JSON.parse(readFileSync(approvalsFile, "utf8"));
      const now = Date.now();
      const kept = Object.entries(raw?.pending || {})
        .filter(([, item]) => {
          if (!item?.delivery || now - (item.savedAt || 0) >= approvalTtlMs) return false;
          const assignments = Array.isArray(item.delivery.assignments) ? item.delivery.assignments : [];
          return item.approvalRequired === true
            || item.delivery.choices?.length > 0
            || (item.agentKey === "project_manager" && assignments.length > 0);
        })
        .map(([key, item]) => [key, item]);
      if (kept.length) log.info?.(`[orchestrator] restored ${kept.length} pending approval(s) from ${approvalsFile}`);
      return kept;
    } catch {
      return [];
    }
  }

  function persistApprovals() {
    if (!approvalsFile) return;
    try {
      const pending = Object.fromEntries([...approvals.entries()].map(([key, item]) => [key, { ...item, savedAt: item.savedAt || Date.now() }]));
      mkdirSync(dirname(approvalsFile), { recursive: true });
      writeFileSync(approvalsFile, JSON.stringify({ pending }, null, 2));
    } catch (error) {
      log.error?.(`approvals persist failed: ${error.message}`);
    }
  }

  function restoreCheckpoints() {
    if (!checkpointFile) return [];
    try {
      const raw = JSON.parse(readFileSync(checkpointFile, "utf8"));
      return Object.entries(raw?.pending || {});
    } catch {
      return [];
    }
  }

  function persistCheckpoints() {
    if (!checkpointFile) return;
    try {
      mkdirSync(dirname(checkpointFile), { recursive: true });
      writeFileSync(checkpointFile, JSON.stringify({ pending: Object.fromEntries(checkpoints) }, null, 2));
    } catch (error) {
      log.error?.(`[orchestrator] checkpoint persist failed: ${error.message}`);
    }
  }

  function rootOf(taskId) {
    return String(taskId || "").split(":")[0];
  }

  async function terminateTask(taskId) {
    const rootTaskId = rootOf(taskId);
    if (!rootTaskId) return { terminated: false, aborted: 0 };
    const task = await setTerminated(rootTaskId, true);
    const aborted = await abortActiveSessions(rootTaskId);
    for (const [key, item] of approvals) if (rootOf(item.taskId) === rootTaskId) approvals.delete(key);
    for (const [key] of checkpoints) if (rootOf(key) === rootTaskId) checkpoints.delete(key);
    persistApprovals();
    persistCheckpoints();
    await onEvent({ type: "task_terminated", task_id: rootTaskId, aborted_sessions: aborted });
    return { terminated: Boolean(task), aborted };
  }

  async function resumeTask(taskId) {
    const rootTaskId = rootOf(taskId);
    if (!rootTaskId || await isTerminated(rootTaskId)) return 0;
    const task = await setPaused(rootTaskId, false);
    if (!task) return null;
    const pending = [...checkpoints.entries()].filter(([key]) => rootOf(key) === rootTaskId);
    let resumed = 0;
    for (const [key, item] of pending) {
      checkpoints.delete(key);
      persistCheckpoints();
      track((async () => {
        try { await onTaskCompleted(item.agentKey, item.taskId, item.payload); }
        catch (error) { checkpoints.set(key, item); persistCheckpoints(); throw error; }
      })());
      resumed += 1;
    }
    await onEvent({ type: "task_resumed", task_id: rootTaskId, resumed_checkpoints: resumed });
    return resumed;
  }

  // 飞书卡片回调要在 3 秒内应答，而「承接用户选择」可能跑完一整轮 Agent，
  // 因此推进过程放后台，回调只负责认领与回执。
  function track(promise, { suppressFailureEvent = false } = {}) {
    const tracked = Promise.resolve(promise)
      .catch((error) => {
        log.error(JSON.stringify({ type: "continuation", status: "failed", error: error.message }));
        if (!suppressFailureEvent) return Promise.resolve(onEvent({ type: "continuation_failed", error: error.message })).catch(() => {});
        return undefined;
      })
      .finally(() => background.delete(tracked));
    background.add(tracked);
    return tracked;
  }

  function trackContinuation(meta, operation) {
    const taskId = meta?.taskId || null;
    const agentKey = meta?.agentKey || null;
    const chatId = meta?.chatId || null;
    return track((async () => {
      await onEvent({ type: "continuation_started", task_id: taskId, agent: agentKey, chat_id: chatId });
      try {
        const result = await operation();
        await onEvent({ type: "continuation_completed", task_id: taskId, agent: agentKey, chat_id: chatId });
        return result;
      } catch (error) {
        await onEvent({ type: "continuation_failed", task_id: taskId, agent: agentKey, chat_id: chatId, error: error.message });
        throw error;
      }
    })(), { suppressFailureEvent: true });
  }

  // 等后台推进收尾（测试与诊断用）。
  async function whenIdle() {
    while (background.size) await Promise.all([...background]);
  }

  function registerRole(agent, client) {
    roles.set(agent.key, { agent, client });
  }

  // 卡片出按钮的唯一依据：delivery 自带 choices，或该角色在人工确认集合内。
  // 登记待确认必须用同一判定，否则按钮点了必然落空（返回「没有等待选择的任务」）。
  function needsHumanDecision({ agentKey, delivery, context, approvalRequired }) {
    if (!context?.requireHumanApproval || context.approvalBypass) return false;
    if (approvalRequired === true || delivery?.choices?.length) return true;
    const assignments = Array.isArray(delivery?.assignments) ? delivery.assignments : [];
    // 只有项目经理的派发计划属于“决定性抉择”；其他角色的 next 只是建议，
    // 会自动交回项目经理处理，不再让用户点确认卡。
    return agentKey === "project_manager" && assignments.length > 0;
  }

  async function onTaskCompleted(agentKey, taskId, payload = {}) {
    const { delivery, context, parentTaskId, approvalRequired, resultText } = payload;
    if (!delivery) return;
    const rootTaskId = rootOf(taskId);
    if (await isTerminated(rootTaskId)) {
      await onEvent({ type: "task_ignored_terminated", task_id: taskId, parent_task_id: parentTaskId || null });
      return;
    }
    let dispatchContext = context || {};
    const history = deliveryHistory.get(rootTaskId) || [];
    if (!history.some((item) => item.taskId === taskId && item.agentKey === agentKey)) {
      history.push({ taskId, agentKey, summary: String(delivery.summary || resultText || "").trim(), artifactPaths: delivery.artifactPaths || [] });
      deliveryHistory.set(rootTaskId, history);
    }
    // The delivery is the latest project decision from the completed agent.
    // Replace any stale project carried by the previous execution context.
    if (delivery.projectName || dispatchContext.projectName) {
      dispatchContext = {
        ...dispatchContext,
        projectName: delivery.projectName || dispatchContext.projectName,
      };
    }
    await onEvent({
      type: "delivery_received",
      agent: agentKey,
      task_id: taskId,
      parent_task_id: parentTaskId || null,
      chat_id: dispatchContext.chatId || null,
      project_name: dispatchContext.projectName || delivery.projectName || null,
      correlation_id: dispatchContext.correlationId || null,
      final: delivery.final === true,
      artifact_paths: delivery.artifactPaths || [],
      artifact_count: delivery.artifactPaths?.length || 0,
      blockers: delivery.blockers || [],
      risks: delivery.risks || [],
      choices: (delivery.choices || []).map((item) => item.id),
      assignments: (delivery.assignments || []).map((item) => item.agentKey),
      summary: String(delivery.summary || "").slice(0, 1000),
    });
    let settleEmptyAssignments = false;
    if (agentKey === "project_manager" && !delivery.final && Object.prototype.hasOwnProperty.call(delivery, "assignments")) {
      const assignments = Array.isArray(delivery.assignments) ? delivery.assignments : [];
      await onEvent({ type: "task_plan_created", task_id: taskId, parent_task_id: parentTaskId || null, agents: assignments.map((item) => item.agentKey), chat_id: dispatchContext.chatId || null });
      if (assignments.length) {
        dispatchContext = {
          ...dispatchContext,
          selectedAgents: assignments.map((item) => item.agentKey),
          assignmentTasks: Object.fromEntries(assignments.map((item) => [item.agentKey, item.task])),
        };
      } else settleEmptyAssignments = !String(delivery.next || "").trim() && !delivery.choices?.length && !needsHumanDecision({ agentKey, delivery, context: dispatchContext, approvalRequired });
    }
    if (await isTerminated(rootTaskId)) return;
    if (await isPaused(rootTaskId)) {
      checkpoints.set(taskId, { agentKey, taskId, payload: { delivery, context: dispatchContext, parentTaskId, approvalRequired } });
      persistCheckpoints();
      await onEvent({ type: "task_hold", task_id: taskId, reason: "paused" });
      log.info(JSON.stringify({ type: "hold", task_id: taskId, reason: "paused" }));
      return;
    }
    if (delivery.final) {
      await onEvent({ type: "task_settle", task_id: taskId, reason: "final" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "final" }));
      return;
    }
    if (needsHumanDecision({ agentKey, delivery, context: dispatchContext, approvalRequired })) {
      approvals.set(`${dispatchContext?.chatId || ""}:${taskId}`, { agentKey, taskId, delivery, context: dispatchContext, parentTaskId, approvalRequired: approvalRequired === true });
      persistApprovals();
      await onEvent({ type: "approval_required", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId || null, chat_id: dispatchContext?.chatId || null, project_name: dispatchContext?.projectName || delivery?.projectName || null, correlation_id: dispatchContext?.correlationId || null, artifact_count: delivery?.artifactPaths?.length || 0 });
      log.info(JSON.stringify({ type: "approval_required", agent: agentKey, task_id: taskId }));
      return;
    }
    if (settleEmptyAssignments) {
      await onEvent({ type: "task_settle", task_id: taskId, reason: "no_assignments" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_assignments" }));
      return;
    }
    if (agentKey === "project_manager" && dispatchContext.selectedAgents) {
      const initialTargets = dispatchContext.selectedAgents.filter((target) => target !== "project_manager" && roles.has(target));
      await Promise.all(initialTargets.map((target) => dispatchTo(target, taskId, {
        context: { ...dispatchContext, approvalBypass: false, pmCoordination: false },
        parentDelivery: delivery,
        fromAgent: agentKey,
      })));
      return;
    }
    // 终止条件二：单任务派发轮次上限，防协作死循环
    const root = rootTaskId;
    const round = rootRounds.get(root) || 0;
    if (round >= maxRounds) {
      log.warn(JSON.stringify({ type: "settle", task_id: taskId, reason: "max_rounds", rounds: round }));
      await onEvent({ type: "task_settle", task_id: taskId, reason: "max_rounds", rounds: round });
      return;
    }
    rootRounds.set(root, round + 1);

    const routineNext = Boolean(String(delivery.next || "").trim()) && !delivery.choices?.length;
    if (agentKey !== "project_manager" && routineNext && roles.has("project_manager")) {
      // 非 PM 没有派发权限：把建议交回 PM 决策，不弹人工确认卡。
      await dispatchTo("project_manager", taskId, {
        context: { ...dispatchContext, approvalBypass: false, pmCoordination: true },
        parentDelivery: delivery,
        fromAgent: agentKey,
      });
      return;
    }
    if (agentKey === "project_manager" && routineNext && !dispatchContext.selectedAgents?.length) {
      // PM 自己能做的常规下一步直接续跑，不弹确认卡。
      trackContinuation(
        { taskId, agentKey, chatId: dispatchContext.chatId || null },
        () => continueWithSelection({ agentKey, taskId, delivery, context: dispatchContext, parentTaskId }, "continue", delivery.next),
      );
      return;
    }

    let dispatchedDownstream = false;
    let waitingForDownstream = false;
    for (const rule of matchRoutes(routesConfig.routes, agentKey)) {
      const selected = dispatchContext.selectedAgents;
      const targets = rule.tos;
      if (!targets.length) continue;
      if (rule.when === "always") {
        dispatchedDownstream = true;
        await Promise.all(
          targets.map((target) =>
            dispatchTo(target, taskId, { context: { ...dispatchContext, approvalBypass: false, pmCoordination: false }, parentDelivery: delivery, fromAgent: agentKey }),
          ),
        );
      } else if (rule.when === "all_done") {
    // 汇聚屏障：等 from 列表里所有角色都完成，才派发一次下游
    const base = parentTaskId || taskId;
        const selectedFroms = selected ? rule.froms.filter((from) => selected.includes(from)) : [];
        const requiredFroms = selectedFroms.length ? selectedFroms : rule.froms;
        const key = `${base}->${targets.join(",")}`;
        const done = dispatchGroups.get(key) || new Set();
        done.add(agentKey);
        dispatchGroups.set(key, done);
        if (requiredFroms.every((f) => done.has(f))) {
          dispatchGroups.delete(key);
          dispatchedDownstream = true;
          await Promise.all(
            targets.map((target) =>
              dispatchTo(target, base, { context: { ...dispatchContext, approvalBypass: false, pmCoordination: false }, parentDelivery: delivery, fromAgent: agentKey }),
            ),
          );
        } else waitingForDownstream = true;
      }
    }
    if (!dispatchedDownstream && !waitingForDownstream) {
      await onEvent({ type: "task_settle", task_id: taskId, reason: "no_next_step" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_next_step" }));
    }
  }

  async function dispatchTo(targetKey, parentTaskId, { context, parentDelivery, fromAgent }) {
    const rootTaskId = rootOf(parentTaskId);
    if (await isTerminated(rootTaskId)) return;
    const role = roles.get(targetKey);
    if (!role) {
      log.warn(`[orchestrator] 鏈敞鍐岃鑹? ${targetKey}`);
      return;
    }
    const { agent, client } = role;
    const subTaskId = `${parentTaskId}:${targetKey}`;
    // 项目名必须与写入白名单同源：上游交付包里的 projectName 是最新事实，
    // 只读 context 会让下游的白名单退化成 workspace/default，合法写入被拒。
    const projectName = parentDelivery.projectName || context.projectName || null;
    const artifactsDir = artifactsDirFor(parentTaskId, projectName);
    const upstreamDir = parentDelivery.artifactsDir;
    const refs = (parentDelivery.artifactPaths || []).map((p) => `- ${p}`).join("\n");
    const assignedTask = context.assignmentTasks?.[targetKey];
    const priorDeliveries = (deliveryHistory.get(rootTaskId) || [])
      .filter((item) => item.taskId !== subTaskId)
      .map((item) => `- ${item.agentKey}: ${item.summary || "已完成交付"}${item.artifactPaths?.length ? `（产物 ${item.artifactPaths.join(", ")}）` : ""}`)
      .join("\n");

    const pmInstruction = context.pmCoordination
      ? "作为项目经理，请判断上游建议的下一步：能自己完成的直接交付；确需其他角色时用 assignments 明确派发必要角色并说明理由，不要扩大范围或重复派发。"
      : "作为项目经理，请基于以上所有机器人交付逐项汇总已完成内容、产物、验证结果和遗留风险，不要只回复‘任务已完成’。";
    const prompt = [
      assignedTask ? `分配任务：${assignedTask}` : "",
      `上游机器人：${fromAgent}；交付摘要：${parentDelivery.summary}`,
      parentDelivery.next ? `上游建议的下一步：${parentDelivery.next}` : "",
      refs ? `上游产物：\n${refs}` : "",
      priorDeliveries ? `前序机器人交付记录：\n${priorDeliveries}` : "",
      targetKey === "project_manager" ? pmInstruction : "",
      context.selection ? `用户选择：${context.selection}` : "",
      "",
      upstreamDir && upstreamDir !== artifactsDir ? `上游产物目录：${upstreamDir}` : "",
      context.pmCoordination
        ? "请处理上游建议：能自己完成就直接交付；确需其他角色时使用 assignments 明确派发。"
        : `请读取 ${artifactsDir} 中的上游产物，完成分配任务，并调用 deliver_artifact 交付。`,
      "无需等待澄清；信息不足时请做合理假设并在交付摘要中说明。",
      "不要输出思考过程、工具调用过程、英文工作日志或本提示词；只输出最终中文结果。",
    ].filter(Boolean).join("\n");

    try {
      log.info(`[dispatch] ${fromAgent} -> ${agent.displayName} (subtask ${String(subTaskId).slice(0, 8)})`);
      await onEvent({ type: "dispatch_started", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, task_id: subTaskId, chat_id: context?.chatId || null, project_name: projectName, correlation_id: context?.correlationId || null, assigned_task: assignedTask || null });
      await sendCard(client, context.chatId, buildTaskReceivedCard(agent, subTaskId, assignedTask || parentDelivery.summary));
      const result = await runAgent(agent, prompt, {
        taskId: subTaskId,
        parentTaskId,
        agentKey: agent.key,
        appId: agent.appId,
        chatId: context.chatId,
        projectName,
        artifactsDir,
        onEvent,
      });
      if (result.cancelled || await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", from: fromAgent, target: targetKey, task_id: subTaskId, parent_task_id: rootTaskId });
        return;
      }
      await sendResultCard(client, context.chatId, result, { log, taskId: subTaskId });
      log.info(JSON.stringify({ type: "dispatch", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, status: "completed" }));
      await onEvent({ type: "dispatch_completed", agent: targetKey, from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, task_id: subTaskId, chat_id: context?.chatId || null, project_name: projectName, correlation_id: context?.correlationId || null, has_delivery: Boolean(result.delivery), artifact_count: result.delivery?.artifactPaths?.length || 0 });
      await onTaskCompleted(agent.key, subTaskId, {
        delivery: result.delivery || { agentKey: agent.key, agentName: agent.displayName, summary: result.text || "已完成交付", artifactPaths: [], final: false },
        resultText: result.text,
        context,
        parentTaskId,
        approvalRequired: result.approvalRequired === true,
      });
    } catch (error) {
      if (await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", agent: targetKey, task_id: subTaskId, parent_task_id: rootTaskId });
        return;
      }
      log.error(JSON.stringify({ type: "dispatch", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, status: "failed", error: error.message }));
      await onEvent({ type: "dispatch_failed", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, task_id: subTaskId, chat_id: context?.chatId || null, project_name: projectName, correlation_id: context?.correlationId || null, error: error.message });
      try {
        await sendText(client, context.chatId, `Task failed: ${error.message}`);
      } catch {
      }
    }
  }

  async function resolveLatest(chatId, selection = "approve", requestedTaskId = null) {
    const taskId = requestedTaskId === null || requestedTaskId === undefined || requestedTaskId === ""
      ? null
      : String(requestedTaskId);
    const entries = [...approvals.entries()].filter(([key, item]) => key.startsWith(`${chatId}:`) && (!taskId || String(item.taskId) === taskId));
    const pending = entries.at(-1)?.[1];
    if (!pending) return null;
    approvals.delete(entries.at(-1)[0]);
    persistApprovals();
    const info = {
      approved: true,
      agentKey: pending.agentKey,
      agentName: roles.get(pending.agentKey)?.agent?.displayName || pending.agentKey,
      taskId: pending.taskId,
      selection,
    };
    const assignments = Array.isArray(pending.delivery?.assignments) ? pending.delivery.assignments : [];
    const asksUser = Boolean(pending.delivery?.choices?.length);
    const hasNext = Boolean(String(pending.delivery?.next || "").trim());
    // 只有显式 assignments 才是派发信号；choices 和 next 都表示原角色继续推进，
    // 避免项目经理能自己做的下一步被配置路由误发给下游。
    trackContinuation(
      { taskId: pending.taskId, agentKey: pending.agentKey, chatId },
      () => {
        if (assignments.length) return onTaskCompleted(pending.agentKey, pending.taskId, { ...pending, context: { ...pending.context, approvalBypass: true, selection } });
        if (asksUser) return continueWithSelection(pending, selection);
        if (hasNext) return continueWithSelection(pending, selection, pending.delivery.next);
        return onTaskCompleted(pending.agentKey, pending.taskId, { ...pending, context: { ...pending.context, approvalBypass: true, selection } });
      },
    );
    return info;
  }

  async function continueWithSelection(pending, selection, confirmedNext = "") {
    const role = roles.get(pending.agentKey);
    const chatId = pending.context?.chatId;
    if (!role || !chatId) return;
    const rootTaskId = rootOf(pending.taskId);
    if (await isTerminated(rootTaskId)) return;
    const { agent, client } = role;
    const delivery = pending.delivery || {};
    const choice = selection ? (delivery.choices || []).find((item) => item.id === selection) : null;
    const projectName = delivery.projectName || pending.context?.projectName || null;
    const artifactsDir = artifactsDirFor(pending.taskId, projectName);
    const prompt = [
      choice ? `用户选择：${choice.label || selection}（${selection}）` : "",
      confirmedNext ? `用户确认的下一步：${confirmedNext}` : "",
      delivery.summary ? `上一轮交付摘要：${delivery.summary}` : "",
      delivery.artifactsDir && delivery.artifactsDir !== artifactsDir ? `上一轮产物目录（可读）：${delivery.artifactsDir}` : "",
      "请继续执行已确认的工作，产出后调用 deliver_artifact 交付；若仍需用户确认，继续给出 choices。",
    ].filter(Boolean).join("\n");
    try {
      log.info(`[dispatch] user selection "${selection}" -> ${agent.displayName}`);
      const result = await runAgent(agent, prompt, {
        taskId: pending.taskId,
        parentTaskId: pending.parentTaskId,
        agentKey: agent.key,
        appId: agent.appId,
        chatId,
        projectName,
        artifactsDir,
        onEvent,
      });
      if (result.cancelled || await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", agent: agent.key, task_id: pending.taskId, parent_task_id: rootTaskId });
        return;
      }
      await sendResultCard(client, chatId, result, { log, taskId: pending.taskId });
      if (result.delivery) {
        await onTaskCompleted(agent.key, pending.taskId, {
          delivery: result.delivery,
          resultText: result.text,
          context: pending.context,
          parentTaskId: pending.parentTaskId,
          approvalRequired: result.approvalRequired === true,
        });
      }
    } catch (error) {
      if (await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", agent: agent.key, task_id: pending.taskId, parent_task_id: rootTaskId });
        return;
      }
      log.error(JSON.stringify({ type: "selection", agent: agent.key, status: "failed", error: error.message }));
      await onEvent({ type: "selection_failed", agent: agent.key, task_id: pending.taskId, error: error.message });
      try {
        await sendText(client, chatId, `Task failed: ${error.message}`);
      } catch {
      }
      throw error;
    }
  }

  async function approveLatest(chatId) {
    return resolveLatest(chatId, "approve");
  }

  return { registerRole, onTaskCompleted, approveLatest, resolveLatest, resumeTask, terminateTask, whenIdle };
}

