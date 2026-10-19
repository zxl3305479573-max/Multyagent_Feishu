// 编排层：接收各角色交付，按计划/路由派发下游角色，处理人工确认、暂停检查点与根任务结算。
// 待确认项与检查点的持久化见 orchestrator/pending-store.js，默认路由见 orchestrator/routes.js。
import { buildTaskReceivedCard, loadProjectSummaryFor, sendCard, sendResultCard, sendText } from "./gateway.js";
import { appendProjectSummary } from "./project-summary.js";
import { getRootTask, isPaused, isTerminated, rootAgentKey, setPaused, setTerminated } from "./tasks.js";
import { artifactsDirFor, describeDeliveryArtifacts } from "./artifacts.js";
import { abortActiveSessions } from "./session-control.js";
import { readyPlanAssignments } from "./plan-scheduler.js";
import { createPendingStores } from "./orchestrator/pending-store.js";
import { sequenceArchitectFirst, withAssignments, withoutAssignments } from "./orchestrator/assignments.js";
import { isTerminalNext, matchRoutes, MAX_DISPATCH_ROUNDS, routesConfig } from "./orchestrator/routes.js";
import { ACCEPTANCE_MISSING_NOTE, acceptanceFailureNote, detectVerbalDispatch, dispatchCorrectionNote, failedChecks, inferDispatchTargets } from "./orchestrator/guards.js";

export { matchRoutes };

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
  const dispatchGroups = new Map(); // 汇聚屏障状态：groupKey -> Set(已完成的角色)
  const rootRounds = new Map();
  const deliveryHistory = new Map();
  const { approvals, checkpoints, persistApprovals, persistCheckpoints } = createPendingStores({ approvalsFile, checkpointFile, approvalTtlMs, log });
  const background = new Set();
  const planRuns = new Map();
  // 已交回项目经理汇总（在途或刚交付）的根任务：并发的收尾交付只触发一次最终汇总。
  const pmConsolidations = new Set();
  const isDesktopContext = (context) => context?.channel === "desktop";
  // 根任务的未完结派发计数：归零且无计划/待确认时结算根任务，
  // 否则下游回交完成后根任务会永久停在“执行中”。
  const activeDispatches = new Map();
  const settledRoots = new Set();
  // 每个根任务已交给项目经理重新决策的失败次数，超过上限才把任务判为失败。
  const failureRecoveries = new Map();
  const maxFailureRecoveries = Number(process.env.PI_MAX_FAILURE_RECOVERIES) || 2;
  const pendingSettlements = new Map();
  // 协作守卫已纠正过的次数（派发守卫按根任务、验收纠正按子任务），每类只纠正一次，避免纠正本身陷入循环。
  const corrections = new Map();

  async function emitStageSettlement(event) {
    const rootTaskId = rootOf(event.task_id);
    if (event.task_id !== rootTaskId) return onEvent(event);
    pendingSettlements.set(rootTaskId, event);
    return settleRootIfIdle(rootTaskId);
  }

  function beginDispatch(rootTaskId) {
    // 同一根任务重新开始派发时允许再次结算，避免旧标记把后续进展当终态。
    settledRoots.delete(rootTaskId);
    const set = activeDispatches.get(rootTaskId) || new Set();
    const token = Symbol(rootTaskId);
    set.add(token);
    activeDispatches.set(rootTaskId, set);
    return () => {
      const current = activeDispatches.get(rootTaskId);
      if (!current) return;
      current.delete(token);
      if (!current.size) activeDispatches.delete(rootTaskId);
    };
  }

  async function settleRootIfIdle(rootTaskId) {
    if (!rootTaskId || settledRoots.has(rootTaskId)) return;
    if (activeDispatches.has(rootTaskId)) return;
    if (planRuns.has(rootTaskId)) return;
    if (await isPaused(rootTaskId) || await isTerminated(rootTaskId)) return;
    if ([...checkpoints.keys()].some((taskId) => rootOf(taskId) === rootTaskId)) return;
    if ([...approvals.values()].some((item) => rootOf(item.taskId) === rootTaskId)) return;
    if (activeDispatches.has(rootTaskId) || settledRoots.has(rootTaskId)) return;
    if ([...dispatchGroups.keys()].some((key) => rootOf(key.split("->")[0]) === rootTaskId)) return;
    settledRoots.add(rootTaskId);
    const settlement = pendingSettlements.get(rootTaskId) || { type: "task_settle", task_id: rootTaskId, reason: "all_dispatches_done" };
    pendingSettlements.delete(rootTaskId);
    await onEvent(settlement);
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
    pmConsolidations.delete(rootTaskId);
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
    const endContinuation = beginDispatch(rootOf(taskId));
    return track((async () => {
      try {
        await onEvent({ type: "continuation_started", task_id: taskId, agent: agentKey, chat_id: chatId });
        const result = await operation();
        await onEvent({ type: "continuation_completed", task_id: taskId, agent: agentKey, chat_id: chatId });
        return result;
      } catch (error) {
        await onEvent({ type: "continuation_failed", task_id: taskId, agent: agentKey, chat_id: chatId, error: error.message });
        throw error;
      } finally {
        endContinuation();
        await settleRootIfIdle(rootOf(taskId));
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
    if (!payload.delivery) return;
    const rootTaskId = rootOf(taskId);
    const endProcessing = beginDispatch(rootTaskId);
    try { return await processTaskCompleted(agentKey, taskId, payload); }
    finally {
      endProcessing();
      await settleRootIfIdle(rootTaskId);
    }
  }

  // 交付落地：写事件日志（看板/Trace/桌面端都从这里取数据）并追加项目摘要。
  async function recordDelivery({ agentKey, taskId, parentTaskId, delivery, context, resultText }) {
    await onEvent({
      type: "delivery_received",
      agent: agentKey,
      task_id: taskId,
      parent_task_id: parentTaskId || null,
      chat_id: context.chatId || null,
      project_name: context.projectName || delivery.projectName || null,
      correlation_id: context.correlationId || null,
      final: delivery.final === true,
      artifact_paths: delivery.artifactPaths || [],
      artifact_items: await describeDeliveryArtifacts(delivery, { projectName: context.projectName || delivery.projectName }),
      artifact_count: delivery.artifactPaths?.length || 0,
      blockers: delivery.blockers || [],
      risks: delivery.risks || [],
      next: String(delivery.next || delivery.next_action || "").slice(0, 1000),
      choices: (delivery.choices || []).map((item) => item.id),
      assignments: (delivery.assignments || []).map((item) => item.agentKey),
      summary: String(delivery.summary || "").slice(0, 12000),
    });
    if (delivery.acceptance) {
      const acceptance = delivery.acceptance;
      await onEvent({
        type: "acceptance_submitted",
        agent: agentKey,
        task_id: taskId,
        parent_task_id: parentTaskId || null,
        chat_id: context.chatId || null,
        project_name: context.projectName || delivery.projectName || null,
        verdict: acceptance.verdict,
        summary: acceptance.summary || "",
        checks: acceptance.checks,
        evidence: acceptance.evidence,
        failed_checks: failedChecks(acceptance).map((check) => check.title),
        skip_reason: acceptance.skipReason || null,
      });
    }
    const summaryProject = context.projectName || delivery.projectName || null;
    if (summaryProject) {
      try {
        await appendProjectSummary({
          root: process.cwd(),
          projectName: summaryProject,
          taskId,
          agentKey,
          agentName: roles.get(agentKey)?.agent?.displayName || agentKey,
          delivery,
          resultText,
        });
      } catch (error) {
        log.warn?.(`[orchestrator] project summary append failed: ${error.message}`);
      }
    }
  }

  // 结构化计划的执行进度：项目经理提交新计划时重置，其他角色交付时把对应 assignment 记为完成。
  function trackPlanProgress(agentKey, rootTaskId, delivery) {
    if (agentKey === "project_manager" && delivery.plan?.stages?.length) {
      planRuns.set(rootTaskId, {
        plan: delivery.plan,
        completed: new Set(),
        started: new Set((delivery.assignments || []).map((item) => item.id).filter(Boolean)),
      });
    } else {
      const run = planRuns.get(rootTaskId);
      if (run) {
        const finished = [...run.started].find((id) => run.plan.stages.some((stage) => (stage.assignments || []).some((item) => item.id === id && item.agentKey === agentKey)));
        if (finished) { run.started.delete(finished); run.completed.add(finished); }
      }
    }
  }

  // 按结构化计划推进：派发下一批就绪的 assignment；全部完成后交回项目经理汇总。
  // 返回 true 表示本次交付已由计划接管（无论是否实际派发）。
  async function advancePlan({ agentKey, taskId, rootTaskId, delivery, context }) {
    const planRun = planRuns.get(rootTaskId);
    if (!planRun) return false;
    const ready = readyPlanAssignments(planRun.plan, [...planRun.completed], [...planRun.started]);
    if (ready.length) {
      ready.forEach((assignment) => planRun.started.add(assignment.id));
      const nextContext = withAssignments(context, ready);
      await Promise.all(ready.map((assignment) => dispatchTo(assignment.agentKey, taskId, { context: nextContext, parentDelivery: delivery, fromAgent: "project_manager" })));
      return true;
    }
    const remaining = planRun.plan.stages.flatMap((stage) => stage.assignments || []).some((assignment) => !planRun.completed.has(assignment.id));
    if (remaining) return true;
    planRuns.delete(rootTaskId);
    await onEvent({ type: "task_plan_completed", task_id: rootTaskId, plan_project: planRun.plan.project || null });
    if (roles.has("project_manager") && !pmConsolidations.has(rootTaskId)) {
      pmConsolidations.add(rootTaskId);
      await dispatchTo("project_manager", taskId, {
        // planCompleted：阶段全部交付完成，明确要求 PM 做最终汇总，而不是只判断下一步。
        context: { ...withoutAssignments(context), pmCoordination: true, planCompleted: true, approvalBypass: false },
        parentDelivery: delivery,
        fromAgent: agentKey,
      });
    }
    return true;
  }

  // 静态路由（config/routes.json）派发；没有任何下游可派发时结算本阶段。
  async function dispatchByRoutes({ agentKey, taskId, parentTaskId, delivery, context }) {
    let dispatchedDownstream = false;
    let waitingForDownstream = false;
    for (const rule of agentKey === "project_manager" && context.channel === "desktop" ? [] : matchRoutes(routesConfig.routes, agentKey)) {
      const selected = context.selectedAgents;
      const targets = rule.tos;
      if (!targets.length) continue;
      if (rule.when === "always") {
        dispatchedDownstream = true;
        await Promise.all(
          targets.map((target) =>
            dispatchTo(target, taskId, { context: { ...context, approvalBypass: false, pmCoordination: false }, parentDelivery: delivery, fromAgent: agentKey }),
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
              dispatchTo(target, base, { context: { ...context, approvalBypass: false, pmCoordination: false }, parentDelivery: delivery, fromAgent: agentKey }),
            ),
          );
        } else waitingForDownstream = true;
      }
    }
    if (!dispatchedDownstream && !waitingForDownstream) {
      await emitStageSettlement({ type: "task_settle", task_id: taskId, reason: "no_next_step" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_next_step" }));
    }
  }

  // 计划仍有未完成的 assignment 时，执行角色的 final 不能提前结算根任务：
  // 例如架构设计师交付 final=true 后，后续开发阶段仍需按计划派发。
  function planHasRemaining(rootTaskId) {
    const run = planRuns.get(rootTaskId);
    if (!run) return false;
    return run.plan.stages.some((stage) => (stage.assignments || []).some((item) => !run.completed.has(item.id)));
  }

  // 根任务是否由项目经理发起（桌面端提交、飞书 @项目经理）。只有这种任务链
  // 才要求「所有角色完成后回到项目经理汇总」；用户直接 @执行角色的单角色
  // 任务仍由该角色自行收尾，不额外拉起项目经理。
  async function projectManagerOwnsRoot(rootTaskId) {
    if (!rootTaskId || !roles.has("project_manager")) return false;
    const owner = await rootAgentKey(rootTaskId);
    if (owner) return owner === "project_manager";
    // 任务记录不可用时退化为「根任务的首个交付角色」，避免把 PM 发起的任务链判成单角色任务。
    const first = (deliveryHistory.get(rootTaskId) || []).find((item) => item.taskId === rootTaskId);
    return first?.agentKey === "project_manager";
  }

  // 终止条件：单任务派发轮次上限，防止「交回 PM → 再派发」这类协作死循环。
  // 返回 false 表示本轮预算已用尽并已结算根任务。
  async function withinRoundBudget(taskId) {
    const root = rootOf(taskId);
    const round = rootRounds.get(root) || 0;
    if (round >= maxRounds) {
      log.warn(JSON.stringify({ type: "settle", task_id: taskId, reason: "max_rounds", rounds: round }));
      await emitStageSettlement({ type: "task_settle", task_id: taskId, reason: "max_rounds", rounds: round });
      return false;
    }
    rootRounds.set(root, round + 1);
    return true;
  }

  function clearRootPlan(rootTaskId) {
    planRuns.delete(rootTaskId);
    pmConsolidations.delete(rootTaskId);
    for (const key of [...dispatchGroups.keys()]) if (rootOf(key.split("->")[0]) === rootTaskId) dispatchGroups.delete(key);
  }

  // 协作守卫（借鉴 team-leader-guard / acceptance gate）：
  // - 项目经理“嘴上派发”：先纠正一次；仍未给出有效 assignments 时按文字推断兜底派发，推断不出则判失败等人工重试。
  // - 测试未提交结构化验收：纠正一次；验收 fail 时清掉计划残留，交回项目经理决定打回谁修复。
  // 返回 { handled: true } 表示本次交付已由守卫接管；返回 { delivery, context } 表示改写后继续正常流程。
  async function applyCollaborationGuards({ agentKey, taskId, parentTaskId, rootTaskId, delivery, resultText, context }) {
    if (agentKey === "project_manager") {
      const dispatchKey = `${rootTaskId}#dispatch`;
      if (delivery.assignments?.length) { corrections.delete(dispatchKey); return {}; }
      const detection = detectVerbalDispatch({ delivery, resultText });
      if (!detection) return {};
      const available = [...roles.keys()];
      if (!corrections.has(dispatchKey)) {
        corrections.set(dispatchKey, 1);
        if (!(await withinRoundBudget(taskId))) return { handled: true };
        await onEvent({ type: "dispatch_correction", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId || null, project_name: context.projectName || null, chat_id: context.chatId || null, reason: detection.reason, detail: detection.detail.slice(0, 300) });
        await dispatchTo("project_manager", taskId, {
          context: { ...withoutAssignments(context), pmCoordination: true, planCompleted: false, approvalBypass: false, correctionNote: dispatchCorrectionNote(detection, available) },
          parentDelivery: delivery,
          fromAgent: "dispatch_guard",
        });
        return { handled: true };
      }
      corrections.delete(dispatchKey);
      const text = [delivery.summary, delivery.next, resultText].filter(Boolean).join("\n");
      const targets = inferDispatchTargets(text, available);
      if (!targets.length) {
        await onEvent({ type: "task_failed", task_id: rootTaskId, agent: agentKey, project_name: context.projectName || null, error: "项目经理声称已派发但未提交有效 assignments，自动纠正后仍无法确定派发对象，请重试或补充说明" });
        return { handled: true };
      }
      const task = String(delivery.next || delivery.summary || "").trim().slice(0, 1000);
      const assignments = targets.map((target) => ({ agentKey: target, task, reason: "派发守卫兜底：项目经理未提交有效 assignments" }));
      await onEvent({ type: "dispatch_fallback", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId || null, project_name: context.projectName || null, chat_id: context.chatId || null, targets, reason: detection.reason });
      // 飞书卡片在守卫改写前已按原交付发出（没有确认按钮），兜底派发若再登记待确认就无人能点，故直接执行。
      return { delivery: { ...delivery, assignments }, context: { ...withAssignments(context, assignments), approvalBypass: true } };
    }
    if (agentKey !== "tester") return {};
    const acceptance = delivery.acceptance;
    const pmOwned = roles.has("project_manager") && await projectManagerOwnsRoot(rootTaskId);
    if (!acceptance) {
      const acceptanceKey = `${taskId}#acceptance`;
      // 验收门禁只约束项目经理主导的任务链，且只有编排层派发的测试才能原样重派；
      // 用户直接 @测试 或静态路由的单角色任务只记录缺失。
      if (pmOwned && parentTaskId && !corrections.has(acceptanceKey)) {
        corrections.set(acceptanceKey, 1);
        await onEvent({ type: "acceptance_correction", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId, project_name: context.projectName || null, chat_id: context.chatId || null });
        await dispatchTo("tester", parentTaskId, {
          context: { ...context, approvalBypass: false, pmCoordination: false, correctionNote: ACCEPTANCE_MISSING_NOTE },
          parentDelivery: { ...delivery, summary: `你上一轮的交付：${delivery.summary || "（无摘要）"}` },
          fromAgent: "acceptance_gate",
        });
        return { handled: true };
      }
      await onEvent({ type: "acceptance_missing", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId || null, project_name: context.projectName || null, chat_id: context.chatId || null });
      if (!pmOwned) return {};
      return handAcceptanceToProjectManager({ taskId, rootTaskId, delivery, context, note: "【验收缺失】测试两次都没有提交结构化验收结果，本轮实现视为未经验证。请决定重新派发测试（写明验收标准），或说明不需要验收的理由。" });
    }
    if (acceptance.verdict !== "fail" || !pmOwned) return {};
    return handAcceptanceToProjectManager({ taskId, rootTaskId, delivery, context, note: acceptanceFailureNote(acceptance) });
  }

  // 验收未通过或缺失：不再按计划/路由推进到审计或收尾，清掉残留后交回项目经理决定由谁修复。
  async function handAcceptanceToProjectManager({ taskId, rootTaskId, delivery, context, note }) {
    if (!(await withinRoundBudget(taskId))) return { handled: true };
    clearRootPlan(rootTaskId);
    await onEvent({ type: "acceptance_failed_handed_to_pm", agent: "tester", task_id: taskId, project_name: context.projectName || null, chat_id: context.chatId || null, failed_checks: failedChecks(delivery.acceptance).map((check) => check.title) });
    await dispatchTo("project_manager", taskId, {
      context: { ...withoutAssignments(context), pmCoordination: true, planCompleted: false, approvalBypass: false, correctionNote: note },
      parentDelivery: delivery,
      fromAgent: "tester",
    });
    return { handled: true };
  }

  async function processTaskCompleted(agentKey, taskId, payload = {}) {
    const { context, parentTaskId, approvalRequired, resultText } = payload;
    let { delivery } = payload;
    if (!delivery) return;
    // 项目经理同时派发架构设计师与其他角色时，架构先行（见 sequenceArchitectFirst）。
    if (agentKey === "project_manager" && !delivery.final) delivery = sequenceArchitectFirst(delivery);
    const rootTaskId = rootOf(taskId);
    if (await isTerminated(rootTaskId)) {
      await onEvent({ type: "task_ignored_terminated", task_id: taskId, parent_task_id: parentTaskId || null });
      return;
    }
    let dispatchContext = context || {};
    if (agentKey === "project_manager" && isDesktopContext(dispatchContext)) {
      dispatchContext = withoutAssignments(dispatchContext);
    }
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
    await recordDelivery({ agentKey, taskId, parentTaskId, delivery, context: dispatchContext, resultText });
    // 项目经理已交付（汇总或新一轮派发），后续收尾交付可以再次交回它决策。
    if (agentKey === "project_manager") pmConsolidations.delete(rootTaskId);
    trackPlanProgress(agentKey, rootTaskId, delivery);
    let settleEmptyAssignments = false;
    if (agentKey === "project_manager" && !delivery.final && Object.prototype.hasOwnProperty.call(delivery, "assignments")) {
      const assignments = Array.isArray(delivery.assignments) ? delivery.assignments : [];
      await onEvent({
        type: "task_plan_created",
        task_id: taskId,
        parent_task_id: parentTaskId || null,
        agents: assignments.map((item) => item.agentKey),
        plan_project: delivery.plan?.project || dispatchContext.projectName || delivery.projectName || null,
        plan_stage_count: Array.isArray(delivery.plan?.stages) ? delivery.plan.stages.length : null,
        plan_assignment_ids: Array.isArray(delivery.plan?.stages) ? delivery.plan.stages.flatMap((stage) => (stage.assignments || []).map((item) => item.id)).filter(Boolean) : [],
        chat_id: dispatchContext.chatId || null,
      });
      if (assignments.length) {
        dispatchContext = withAssignments(dispatchContext, assignments);
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
    const guarded = await applyCollaborationGuards({ agentKey, taskId, parentTaskId, rootTaskId, delivery, resultText, context: dispatchContext });
    if (guarded.handled) return;
    if (guarded.delivery) {
      delivery = guarded.delivery;
      dispatchContext = guarded.context;
      settleEmptyAssignments = false;
    }
    if (delivery.final && !(agentKey !== "project_manager" && planHasRemaining(rootTaskId))) {
      // 只有项目经理的 final 才代表整条任务链结束。其他角色声明 final 只说明
      // 它这一阶段无需下游协作，仍要回到项目经理做最终汇总。
      if (agentKey === "project_manager" || !(await projectManagerOwnsRoot(rootTaskId)) || delivery.choices?.length) {
        await emitStageSettlement({ type: "task_settle", task_id: taskId, reason: "final" });
        log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "final" }));
        return;
      }
      // 计划调度优先：仍有就绪阶段就继续派发，计划收尾时由 advancePlan 交回 PM。
      if (await advancePlan({ agentKey, taskId, rootTaskId, delivery, context: dispatchContext })) return;
      // 并发的收尾交付只汇总一次：已有 PM 汇总在途时不再重复交回。
      if (pmConsolidations.has(rootTaskId)) return;
      if (!(await withinRoundBudget(taskId))) return;
      pmConsolidations.add(rootTaskId);
      await onEvent({ type: "final_deferred", agent: agentKey, task_id: taskId, parent_task_id: parentTaskId || null, reason: "await_project_manager_summary" });
      log.info(JSON.stringify({ type: "final_deferred", task_id: taskId, agent: agentKey }));
      await dispatchTo("project_manager", taskId, {
        context: { ...withoutAssignments(dispatchContext), planCompleted: true, approvalBypass: false },
        parentDelivery: delivery,
        fromAgent: agentKey,
      });
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
      await emitStageSettlement({ type: "task_settle", task_id: taskId, reason: "no_assignments" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_assignments" }));
      return;
    }
    if (agentKey === "project_manager" && dispatchContext.selectedAgents?.length) {
      const initialTargets = dispatchContext.selectedAgents.filter((target) => target !== "project_manager" && roles.has(target));
      if (initialTargets.length) {
        await Promise.all(initialTargets.map((target) => dispatchTo(target, taskId, {
          context: { ...dispatchContext, approvalBypass: false, pmCoordination: false },
          parentDelivery: delivery,
          fromAgent: agentKey,
        })));
        return;
      }
    }
    // 项目经理只有在本轮明确给出 assignments 时才有派发资格。
    // 静态 routes 只服务于已有下游链路，不能把 PM-only 任务自动变成架构任务。
    if (agentKey === "project_manager" && dispatchContext.channel === "desktop" && isTerminalNext(delivery.next)) {
      await emitStageSettlement({ type: "task_settle", task_id: taskId, reason: "no_next_step" });
      log.info(JSON.stringify({ type: "settle", task_id: taskId, reason: "no_next_step" }));
      return;
    }
    if (agentKey !== "project_manager" && await advancePlan({ agentKey, taskId, rootTaskId, delivery, context: dispatchContext })) return;
    // 终止条件二：单任务派发轮次上限，防协作死循环
    if (!(await withinRoundBudget(taskId))) return;


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

    await dispatchByRoutes({ agentKey, taskId, parentTaskId, delivery, context: dispatchContext });
  }

  async function dispatchTo(targetKey, parentTaskId, { context, parentDelivery, fromAgent }) {
    // PM 被下游回交时只负责汇总当前结果，不能继承上一阶段的派发清单。
    if (targetKey === "project_manager") {
      context = { ...context, selectedAgents: [], assignmentTasks: {}, assignmentPermissions: {} };
    }
    const rootTaskId = rootOf(parentTaskId);
    if (await isTerminated(rootTaskId)) return;
    const role = roles.get(targetKey);
    if (!role) {
      log.warn(`[orchestrator] 未注册的角色: ${targetKey}`);
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
    const taskPermissions = context.assignmentPermissions?.[targetKey] || null;
    const priorDeliveries = (deliveryHistory.get(rootTaskId) || [])
      .filter((item) => item.taskId !== subTaskId)
      .map((item) => `- ${item.agentKey}: ${item.summary || "已完成交付"}${item.artifactPaths?.length ? `（产物 ${item.artifactPaths.join(", ")}）` : ""}`)
      .join("\n");

    const pmInstruction = context.manualRetry
      ? `用户要求重试该任务（上次失败原因：${context.manualRetry.error || "未记录"}）。请结合前序机器人交付判断：已成功的阶段不要重复；用 assignments 重新派发必要角色（可换角色、缩小范围或补充说明）、自己直接完成，或在确实无法继续时设置 final=true 并如实说明。`
      : context.failureRecovery
      ? `作为项目经理，下游角色 ${context.failureRecovery.agentKey} 执行失败（${context.failureRecovery.error}）。请决定：用 assignments 重新派发（可换角色、缩小范围或补充说明）、自己直接完成，或在无法继续时设置 final=true 并如实说明失败原因与已完成部分。不要忽略失败，也不要重复派发已成功的阶段。`
      : context.planCompleted
      ? "作为项目经理，本条任务链的全部阶段已交付完成：请基于以上所有机器人交付做最终汇总（逐项列出结论、产物、验证证据、遗留风险），确认全部完成后在交付里设置 final=true，不要只回复‘任务已完成’；只有确有必须补做的工作时，才用 assignments 明确派发必要角色。"
      : context.pmCoordination
        ? "作为项目经理，请判断上游建议的下一步：能自己完成的直接交付；确需其他角色时用 assignments 明确派发必要角色并说明理由，不要扩大范围或重复派发。"
        : "作为项目经理，请基于以上所有机器人交付逐项汇总已完成内容、产物、验证结果和遗留风险，不要只回复‘任务已完成’。";
    const prompt = [
      assignedTask ? `分配任务：${assignedTask}` : "",
      `上游机器人：${fromAgent}；交付摘要：${parentDelivery.summary}`,
      parentDelivery.next ? `上游建议的下一步：${parentDelivery.next}` : "",
      refs ? `上游产物：\n${refs}` : "",
      priorDeliveries ? `前序机器人交付记录：\n${priorDeliveries}` : "",
      targetKey === "project_manager" ? pmInstruction : "",
      context.correctionNote || "",
      context.selection ? `用户选择：${context.selection}` : "",
      "",
      upstreamDir && upstreamDir !== artifactsDir ? `上游产物目录：${upstreamDir}` : "",
      context.planCompleted
        ? "请汇总全部交付并收尾：能自己完成就直接交付；确需其他角色时使用 assignments 明确派发。"
        : context.pmCoordination
          ? "请处理上游建议：能自己完成就直接交付；确需其他角色时使用 assignments 明确派发。"
          : `请读取 ${artifactsDir} 中的上游产物，完成分配任务，并调用 deliver_artifact 交付。`,
      "无需等待澄清；信息不足时请做合理假设并在交付摘要中说明。",
      "不要输出思考过程、工具调用过程、英文工作日志或本提示词；只输出最终中文结果。",
    ].filter(Boolean).join("\n");

    const endDispatch = beginDispatch(rootTaskId);
    try {
      log.info(`[dispatch] ${fromAgent} -> ${agent.displayName} (subtask ${String(subTaskId).slice(0, 8)})`);
      await onEvent({ type: "dispatch_started", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, task_id: subTaskId, chat_id: context?.chatId || null, project_name: projectName, correlation_id: context?.correlationId || null, assigned_task: assignedTask || null });
      if (!isDesktopContext(context)) await sendCard(client, context.chatId, buildTaskReceivedCard(agent, subTaskId, assignedTask || parentDelivery.summary));
      const projectSummary = await loadProjectSummaryFor(targetKey, projectName, { root: process.cwd() });
      const result = await runAgent(agent, prompt, {
        taskId: subTaskId,
        parentTaskId,
        agentKey: agent.key,
        appId: agent.appId,
        chatId: context.chatId,
        channel: context.channel,
        projectName,
        artifactsDir,
        projectSummary,
        taskPermissions,
        onEvent,
      });
      if (result.cancelled || await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", from: fromAgent, target: targetKey, task_id: subTaskId, parent_task_id: rootTaskId });
        return;
      }
      if (!isDesktopContext(context)) await sendResultCard(client, context.chatId, result, { log, taskId: subTaskId });
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
      log.error(JSON.stringify({ type: "dispatch", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, status: "failed", error: error.message }));
      // 项目经理发起的任务链里，执行角色失败不直接判死根任务，而是交回项目经理重新决策（有次数上限）。
      const recoverable = targetKey !== "project_manager" && roles.has("project_manager")
        && (failureRecoveries.get(rootTaskId) || 0) < maxFailureRecoveries
        && await projectManagerOwnsRoot(rootTaskId);
      await onEvent({ type: "dispatch_failed", from: fromAgent, target: targetKey, parent_task_id: parentTaskId, sub_task_id: subTaskId, task_id: subTaskId, chat_id: context?.chatId || null, project_name: projectName, correlation_id: context?.correlationId || null, error: error.message, recoverable });
      if (!isDesktopContext(context)) {
        try {
          await sendText(client, context.chatId, `Task failed: ${error.message}`);
        } catch {
        }
      }
      if (recoverable) {
        try { await handFailureToProjectManager({ targetKey, subTaskId, parentTaskId, rootTaskId, context, projectName, error }); }
        catch (recoveryError) {
          log.error(JSON.stringify({ type: "failure_recovery", task_id: subTaskId, status: "failed", error: recoveryError.message }));
          await onEvent({ type: "task_failed", task_id: rootTaskId, agent: "project_manager", error: `失败恢复未能完成：${recoveryError.message}` });
        }
      }
    } finally {
      endDispatch();
      await settleRootIfIdle(rootTaskId);
    }
  }

  // 失败交回项目经理：清掉失败角色留下的计划/汇聚残留，让 PM 基于失败原因重新规划，
  // 否则残留的 planRuns / dispatchGroups 会让根任务既不结算也不推进。
  async function handFailureToProjectManager({ targetKey, subTaskId, parentTaskId, rootTaskId, context, projectName, error }) {
    failureRecoveries.set(rootTaskId, (failureRecoveries.get(rootTaskId) || 0) + 1);
    planRuns.delete(rootTaskId);
    pmConsolidations.delete(rootTaskId);
    for (const key of [...dispatchGroups.keys()]) if (rootOf(key.split("->")[0]) === rootTaskId) dispatchGroups.delete(key);
    await onEvent({ type: "failure_handed_to_pm", task_id: rootTaskId, failed_agent: targetKey, sub_task_id: subTaskId, attempt: failureRecoveries.get(rootTaskId), max_attempts: maxFailureRecoveries, project_name: projectName, chat_id: context?.chatId || null, error: error.message });
    await dispatchTo("project_manager", parentTaskId, {
      context: { ...withoutAssignments(context), failureRecovery: { agentKey: targetKey, error: String(error.message).slice(0, 500) }, pmCoordination: true, planCompleted: false, approvalBypass: false },
      parentDelivery: { agentKey: targetKey, summary: `${targetKey} 执行失败：${String(error.message).slice(0, 500)}`, artifactPaths: [], projectName },
      fromAgent: targetKey,
    });
  }

  // 手动重试：用户对失败任务点“重试”时，不是盲目重跑失败的派发，而是把任务连同失败原因
  // 交回项目经理重新决策。会重置失败恢复计数、轮次预算和计划残留，让新一轮从干净状态开始。
  async function retryTask(taskId, { error = "" } = {}) {
    const rootTaskId = rootOf(taskId);
    const task = rootTaskId ? await getRootTask(rootTaskId) : null;
    if (!task) return null;
    const status = task.status_snapshot?.status || task.status;
    if (status !== "failed") return { retried: false, status, reason: "只有失败的任务可以重试" };
    if (await isTerminated(rootTaskId)) return { retried: false, status: "cancelled", reason: "任务已终止" };
    if (!roles.has("project_manager")) return { retried: false, status, reason: "项目经理未启用" };
    if (!(await projectManagerOwnsRoot(rootTaskId))) return { retried: false, status, reason: "只有项目经理发起的任务支持重试" };
    const lastError = String(task.status_snapshot?.error || error || "").slice(0, 500);
    const attempt = (task.attempt || 0) + 1;
    failureRecoveries.delete(rootTaskId);
    rootRounds.delete(rootTaskId);
    for (const key of [...corrections.keys()]) if (rootOf(key.split("#")[0]) === rootTaskId) corrections.delete(key);
    planRuns.delete(rootTaskId);
    pmConsolidations.delete(rootTaskId);
    for (const key of [...dispatchGroups.keys()]) if (rootOf(key.split("->")[0]) === rootTaskId) dispatchGroups.delete(key);
    await setPaused(rootTaskId, false);
    const context = {
      chatId: task.source_chat_id || null,
      messageId: task.source_message_id || null,
      correlationId: task.source_message_id || null,
      channel: task.source_chat_id === "desktop-local" ? "desktop" : undefined,
      requireHumanApproval: false,
      projectName: task.project_name || null,
      manualRetry: { error: lastError },
      pmCoordination: true,
      approvalBypass: false,
    };
    await onEvent({ type: "task_retried", task_id: rootTaskId, agent: "project_manager", project_name: task.project_name || null, chat_id: task.source_chat_id || null, attempt, error: lastError || undefined, channel: context.channel });
    trackContinuation(
      { taskId: rootTaskId, agentKey: "project_manager", chatId: task.source_chat_id || null },
      () => dispatchTo("project_manager", rootTaskId, {
        context,
        parentDelivery: { agentKey: "user", summary: `用户请求重试失败的任务${lastError ? `：${lastError}` : ""}`, artifactPaths: [], projectName: task.project_name || null },
        fromAgent: "user",
      }),
    );
    return { retried: true, attempt };
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
        channel: pending.context?.channel,
        projectName,
        artifactsDir,
        onEvent,
      });
      if (result.cancelled || await isTerminated(rootTaskId)) {
        await onEvent({ type: "dispatch_cancelled", agent: agent.key, task_id: pending.taskId, parent_task_id: rootTaskId });
        return;
      }
      if (!isDesktopContext(pending.context)) await sendResultCard(client, chatId, result, { log, taskId: pending.taskId });
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
      if (!isDesktopContext(pending.context)) {
        try {
          await sendText(client, chatId, `Task failed: ${error.message}`);
        } catch {
        }
      }
      throw error;
    }
  }

  async function approveLatest(chatId) {
    return resolveLatest(chatId, "approve");
  }

  return { registerRole, onTaskCompleted, approveLatest, resolveLatest, resumeTask, retryTask, terminateTask, whenIdle };
}

