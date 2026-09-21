// Orchestration and role dispatch.
import { readFile } from "node:fs/promises";
import { buildResultCard, buildTaskReceivedCard, sendCard, sendText } from "./gateway.js";
import { isPaused } from "./tasks.js";
import { artifactsDirFor } from "./artifacts.js";

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

export function createOrchestrator({ runAgent, log = console, maxRounds = MAX_DISPATCH_ROUNDS, onEvent = async () => {} }) {
  const roles = new Map(); // agentKey -> { agent, client }
  const dispatchGroups = new Map(); // 姹囪仛灞忛殰鐘舵€侊細groupKey -> Set(宸插畬鎴愮殑瑙掕壊)
  const rootRounds = new Map();
  const approvals = new Map();

  function registerRole(agent, client) {
    roles.set(agent.key, { agent, client });
  }

  async function onTaskCompleted(agentKey, taskId, { delivery, context, parentTaskId }) {
    if (!delivery) return;
    let dispatchContext = context || {};
    if (agentKey === "project_manager" && !delivery.final && Object.prototype.hasOwnProperty.call(delivery, "assignments")) {
      const assignments = Array.isArray(delivery.assignments) ? delivery.assignments : [];
      if (!assignments.length) {
        await onEvent({ type: "task_settle", task_id: taskId, reason: "no_assignments" });
        log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_assignments" }));
        return;
      }
      dispatchContext = {
        ...dispatchContext,
        selectedAgents: assignments.map((item) => item.agentKey),
        assignmentTasks: Object.fromEntries(assignments.map((item) => [item.agentKey, item.task])),
      };
    }
    const rootTaskId = String(taskId).split(":")[0];
    if (await isPaused(rootTaskId)) {
      await onEvent({ type: "task_hold", task_id: taskId, reason: "paused" });
      log.info(JSON.stringify({ type: "hold", task_id: taskId, reason: "paused" }));
      return;
    }
    if (delivery.final) {
      await onEvent({ type: "task_settle", task_id: taskId, reason: "final" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "final" }));
      return;
    }
    if (dispatchContext?.requireHumanApproval && !dispatchContext.approvalBypass && (agentKey === "project_manager" || agentKey === "architect")) {
      approvals.set(`${dispatchContext?.chatId || ""}:${taskId}`, { agentKey, taskId, delivery, context: dispatchContext, parentTaskId });
      await onEvent({ type: "approval_required", agent: agentKey, task_id: taskId, chat_id: dispatchContext?.chatId });
      log.info(JSON.stringify({ type: "approval_required", agent: agentKey, task_id: taskId }));
      return;
    }
    if (agentKey === "project_manager" && dispatchContext.selectedAgents) {
      const initialTargets = dispatchContext.selectedAgents.filter((target) => target !== "project_manager" && roles.has(target));
      await Promise.all(initialTargets.map((target) => dispatchTo(target, taskId, {
        context: { ...dispatchContext, approvalBypass: false },
        parentDelivery: delivery,
        fromAgent: agentKey,
      })));
      return;
    }
    // 终止条件二：单任务派发轮次上限，防协作死循环
    const root = String(taskId).split(":")[0];
    const round = rootRounds.get(root) || 0;
    if (round >= maxRounds) {
      log.warn(JSON.stringify({ type: "settle", task_id: taskId, reason: "max_rounds", rounds: round }));
      await onEvent({ type: "task_settle", task_id: taskId, reason: "max_rounds", rounds: round });
      return;
    }
    rootRounds.set(root, round + 1);

    for (const rule of matchRoutes(routesConfig.routes, agentKey)) {
      const selected = dispatchContext.selectedAgents;
      const targets = selected ? rule.tos.filter((target) => selected.includes(target)) : rule.tos;
      if (!targets.length || (selected && rule.when === "all_done" && rule.froms.some((from) => !selected.includes(from)))) continue;
      if (rule.when === "always") {
        await Promise.all(
          targets.map((target) =>
            dispatchTo(target, taskId, { context: { ...dispatchContext, approvalBypass: false }, parentDelivery: delivery, fromAgent: agentKey }),
          ),
        );
      } else if (rule.when === "all_done") {
    // 汇聚屏障：等 from 列表里所有角色都完成，才派发一次下游
    const base = parentTaskId || taskId;
        const key = `${base}->${targets.join(",")}`;
        const done = dispatchGroups.get(key) || new Set();
        done.add(agentKey);
        dispatchGroups.set(key, done);
        if (rule.froms.every((f) => done.has(f))) {
          dispatchGroups.delete(key);
          await Promise.all(
            targets.map((target) =>
              dispatchTo(target, base, { context: { ...dispatchContext, approvalBypass: false }, parentDelivery: delivery, fromAgent: agentKey }),
            ),
          );
        }
      }
    }
  }

  async function dispatchTo(targetKey, parentTaskId, { context, parentDelivery, fromAgent }) {
    const role = roles.get(targetKey);
    if (!role) {
      log.warn(`[orchestrator] 鏈敞鍐岃鑹? ${targetKey}`);
      return;
    }
    const { agent, client } = role;
    const subTaskId = `${parentTaskId}:${targetKey}`;
    const projectName = context.projectName || null;
    const artifactsDir =
      parentDelivery.artifactsDir ||
      artifactsDirFor(parentTaskId, projectName);
    const refs = (parentDelivery.artifactPaths || []).map((p) => `- ${p}`).join("\n");
    const assignedTask = context.assignmentTasks?.[targetKey];

    const prompt = [
      assignedTask ? `Assigned task: ${assignedTask}` : "",
      `Upstream agent: ${fromAgent}; delivery: ${parentDelivery.summary}`, 
      refs ? `Artifacts:\n${refs}` : "",
      context.selection ? `User selection: ${context.selection}` : "",
      "",
      `Read upstream artifacts in ${artifactsDir}, produce your deliverable, and call deliver_artifact.`, 
      "Make reasonable assumptions instead of waiting for clarification.",
      "Make reasonable assumptions when details are missing.",
    ].filter(Boolean).join("\n");

    try {
      log.info(`[dispatch] ${fromAgent} -> ${agent.displayName} (subtask ${String(subTaskId).slice(0, 8)})`);
      await onEvent({ type: "dispatch_started", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId });
      await sendCard(client, context.chatId, buildTaskReceivedCard(agent, subTaskId, assignedTask || parentDelivery.summary));
      const result = await runAgent(agent, prompt, {
        taskId: subTaskId,
        parentTaskId,
        agentKey: agent.key,
        appId: agent.appId,
        chatId: context.chatId,
        projectName,
        artifactsDir,
      });
      await sendCard(client, context.chatId, buildResultCard(result));
      log.info(JSON.stringify({ type: "dispatch", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, status: "completed" }));
      await onEvent({ type: "dispatch_completed", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId });
      if (result.delivery) {
        await onTaskCompleted(agent.key, subTaskId, { delivery: result.delivery, context, parentTaskId });
      }
    } catch (error) {
      log.error(JSON.stringify({ type: "dispatch", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, status: "failed", error: error.message }));
      await onEvent({ type: "dispatch_failed", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, error: error.message });
      try {
        await sendText(client, context.chatId, `Task failed: ${error.message}`);
      } catch {
      }
    }
  }

  async function resolveLatest(chatId, selection = "approve") {
    const entries = [...approvals.entries()].filter(([key]) => key.startsWith(`${chatId}:`));
    const pending = entries.at(-1)?.[1];
    if (!pending) return null;
    approvals.delete(entries.at(-1)[0]);
    await onTaskCompleted(pending.agentKey, pending.taskId, { ...pending, context: { ...pending.context, approvalBypass: true, selection } });
    return {
      approved: true,
      agentKey: pending.agentKey,
      agentName: roles.get(pending.agentKey)?.agent?.displayName || pending.agentKey,
      taskId: pending.taskId,
      selection,
    };
  }

  async function approveLatest(chatId) {
    return resolveLatest(chatId, "approve");
  }

  return { registerRole, onTaskCompleted, approveLatest, resolveLatest };
}

