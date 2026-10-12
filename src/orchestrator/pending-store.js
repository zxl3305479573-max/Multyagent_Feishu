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

/**
 * @param {object} options
 * @param {string | null} [options.approvalsFile]
 * @param {string | null} [options.checkpointFile]
 * @param {number} options.approvalTtlMs
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 */
export function createPendingStores({ approvalsFile = null, checkpointFile = null, approvalTtlMs, log = console }) {
  const restoredApprovals = readPending(approvalsFile, log).filter(([, item]) => isRestorableApproval(item, { ttlMs: approvalTtlMs }));
  if (restoredApprovals.length) log.info?.(`[orchestrator] restored ${restoredApprovals.length} pending approval(s) from ${approvalsFile}`);
  const approvals = new Map(restoredApprovals);
  const checkpoints = new Map(readPending(checkpointFile, log));
  return {
    approvals,
    checkpoints,
    persistApprovals() {
      const pending = Object.fromEntries([...approvals.entries()].map(([key, item]) => [key, { ...item, savedAt: item.savedAt || Date.now() }]));
      writePending(approvalsFile, pending, log, "approvals");
    },
    persistCheckpoints() {
      writePending(checkpointFile, Object.fromEntries(checkpoints), log, "checkpoint");
    },
  };
}
