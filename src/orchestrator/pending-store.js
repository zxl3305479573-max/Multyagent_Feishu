// @ts-check
// 编排器的待确认项（approvals）与暂停检查点（checkpoints）持久化。
// 两者都必须跨网关重启存活：重启前发出的确认卡片、暂停时挂起的派发，在重启后仍要能继续。
import { readJsonFileSync, writeFileAtomicSync } from "../atomic-file.cjs";

// 只有真正需要人工决定的交付才值得跨重启保留，其余的恢复后也无从处理。
/** @param {any} item @param {{ now?: number, ttlMs: number }} options */
export function isRestorableApproval(item, { now = Date.now(), ttlMs }) {
  if (!item?.delivery || now - (item.savedAt || 0) >= ttlMs) return false;
  const assignments = Array.isArray(item.delivery.assignments) ? item.delivery.assignments : [];
  return item.approvalRequired === true
    || item.delivery.choices?.length > 0
    || (item.agentKey === "project_manager" && assignments.length > 0);
}

function readPending(file, log) {
  if (!file) return [];
  try {
    const raw = readJsonFileSync(file, { fallback: {}, onCorrupt: "backup", log });
    return Object.entries(raw?.pending || {});
  } catch {
    return [];
  }
}

function writePending(file, pending, log, label) {
  if (!file) return;
  try {
    writeFileAtomicSync(file, JSON.stringify({ pending }, null, 2));
  } catch (error) {
    log.error?.(`[orchestrator] ${label} persist failed: ${error.message}`);
  }
}

// 计划进度落盘：重启后进程里没有任何 Agent 在跑，执行中的切片只能记为“被中断”，
// 由用户重试时从中断处续跑，而不是让项目经理从头重新规划。
/** @param {any} run */
function serializePlanRun(run) {
  return {
    plan: run.plan,
    completed: [...run.completed],
    started: [...run.started],
    failed: [...(run.failed || [])],
    interrupted: [...(run.interrupted || [])],
    dispatchTaskId: run.dispatchTaskId || null,
    context: run.context || {},
    // 按最近一次进展计时：长时间无进展的计划在下次启动时丢弃。
    savedAt: Date.now(),
  };
}

/** @param {any} item */
export function restorePlanRun(item) {
  return {
    plan: item.plan,
    completed: new Set(item.completed || []),
    started: new Set(),
    failed: new Set(item.failed || []),
    interrupted: new Set([...(item.interrupted || []), ...(item.started || [])]),
    dispatchTaskId: item.dispatchTaskId || null,
    context: item.context || {},
    savedAt: item.savedAt || Date.now(),
  };
}

/**
 * @param {object} options
 * @param {string | null} [options.approvalsFile]
 * @param {string | null} [options.checkpointFile]
 * @param {string | null} [options.planRunsFile]
 * @param {number} options.approvalTtlMs
 * @param {number} [options.planRunTtlMs]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 */
export function createPendingStores({ approvalsFile = null, checkpointFile = null, planRunsFile = null, approvalTtlMs, planRunTtlMs = 7 * 24 * 60 * 60 * 1000, log = console }) {
  const restoredApprovals = readPending(approvalsFile, log).filter(([, item]) => isRestorableApproval(item, { ttlMs: approvalTtlMs }));
  if (restoredApprovals.length) log.info?.(`[orchestrator] restored ${restoredApprovals.length} pending approval(s) from ${approvalsFile}`);
  const approvals = new Map(restoredApprovals);
  const checkpoints = new Map(readPending(checkpointFile, log));
  const now = Date.now();
  const restoredPlans = readPending(planRunsFile, log)
    .filter(([, item]) => item?.plan?.stages?.length && now - (item.savedAt || 0) < planRunTtlMs)
    .map(([key, item]) => /** @type {[string, ReturnType<typeof restorePlanRun>]} */ ([key, restorePlanRun(item)]));
  if (restoredPlans.length) log.info?.(`[orchestrator] restored ${restoredPlans.length} plan run(s) from ${planRunsFile}`);
  const planRuns = new Map(restoredPlans);
  return {
    approvals,
    checkpoints,
    planRuns,
    persistPlanRuns() {
      writePending(planRunsFile, Object.fromEntries([...planRuns.entries()].map(([key, run]) => [key, serializePlanRun(run)])), log, "plan runs");
    },
    persistApprovals() {
      const pending = Object.fromEntries([...approvals.entries()].map(([key, item]) => [key, { ...item, savedAt: item.savedAt || Date.now() }]));
      writePending(approvalsFile, pending, log, "approvals");
    },
    persistCheckpoints() {
      writePending(checkpointFile, Object.fromEntries(checkpoints), log, "checkpoint");
    },
  };
}
