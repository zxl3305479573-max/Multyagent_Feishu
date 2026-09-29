// 恢复一条「待确认」状态：从产物目录里的 <role>-delivery.json 重建 approvals 记录，
// 用于因进程重启而失效、但卡片还在群里的情况（重启前发出的卡片否则永远点不动）。
//   node scripts/restore-pending-approval.mjs --delivery <path> --chat <chatId> --task <taskId> [--file runtime/approvals.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const deliveryPath = arg("delivery");
const chatId = arg("chat");
const taskId = arg("task");
const file = arg("file", "runtime/approvals.json");
if (!deliveryPath || !chatId || !taskId) {
  console.error("用法: node scripts/restore-pending-approval.mjs --delivery <path> --chat <chatId> --task <taskId> [--file runtime/approvals.json]");
  process.exit(1);
}
if (!existsSync(deliveryPath)) {
  console.error(`[error] 找不到交付包：${deliveryPath}`);
  process.exit(1);
}

const delivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
if (!delivery?.agentKey) {
  console.error("[error] 交付包里没有 agentKey，无法判断归属角色");
  process.exit(1);
}

let state = { pending: {} };
try {
  state = JSON.parse(readFileSync(file, "utf8"));
  if (!state.pending) state.pending = {};
} catch {
  state = { pending: {} };
}

const parentTaskId = taskId.includes(":") ? taskId.slice(0, taskId.indexOf(":")) : taskId;
state.pending[`${chatId}:${taskId}`] = {
  agentKey: delivery.agentKey,
  taskId,
  delivery,
  context: { chatId, requireHumanApproval: true, projectName: delivery.projectName || null },
  parentTaskId,
  savedAt: Date.now(),
};

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(state, null, 2));
console.log(JSON.stringify({
  restored: `${chatId}:${taskId}`,
  agentKey: delivery.agentKey,
  final: delivery.final === true,
  choices: Array.isArray(delivery.choices) ? delivery.choices.length : 0,
  assignments: Array.isArray(delivery.assignments) ? delivery.assignments.length : 0,
  file,
}, null, 2));
