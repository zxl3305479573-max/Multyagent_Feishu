// @ts-check
// 协作守卫：把“Agent 说了”与“Agent 真的提交了结构化信号”区分开。
//
// 1. 派发守卫：项目经理只有在 deliver_artifact 里给出有效 assignments 才会真正派发。
//    它若只在文字里写“已派发给前端”，或给出的 assignments 全部无效被过滤，任务会悄悄卡住。
//    这里识别这两种情况，由编排层先纠正一次、仍失败再按文字推断兜底。
// 2. 验收门禁：测试必须提交结构化验收结果（结论 + 逐项检查 + 证据），
//    “单元测试通过 / 页面能打开”不能当作通过；未通过时交回项目经理决定打回谁修复。
import { writeScopeOf, writeScopesOverlap } from "./assignments.js";
import { acceptanceFailureRouting } from "../quality-gates.js";

/** 文字里声称已经派发/分配的说法。只在没有有效 assignments 时才有意义。 */
const DISPATCH_CLAIM = /(?:已经?|现已|正在|将会?|马上|立即)\s*(?:派发|派给|分派|分配|指派|交给|交由|转交|安排)|派发(?:给|至)|(?:交给|交由|转交给?|分配给|指派给|安排)\s*(?:架构|前端|后端|测试|审计|architect|frontend|backend|tester|auditor)/iu;

/** 角色在中文表述里的常见叫法；兜底派发时据此从文字推断目标角色。 */
const ROLE_ALIASES = {
  architect: ["架构设计师", "架构师", "架构"],
  frontend_developer: ["前端开发", "前端工程师", "前端"],
  backend_developer: ["后端开发", "后端工程师", "后端"],
  tester: ["测试工程师", "测试"],
  auditor: ["审计", "代码审查", "审查"],
};

/** @param {any} delivery @param {string} [resultText] */
function textOf(delivery = {}, resultText = "") {
  return [delivery.summary, delivery.next, resultText].filter((item) => typeof item === "string" && item.trim()).join("\n");
}

/**
 * 项目经理是否“嘴上派发”：非最终交付、没有有效 assignments、没有给用户的选项、没有结构化计划，
 * 并且提交过但被全部过滤的 assignments，或文字声称已经派发。
 * @param {{ delivery?: any, resultText?: string }} [input]
 * @returns {null | { reason: "dropped_assignments" | "verbal_claim", detail: string }}
 */
export function detectVerbalDispatch({ delivery = {}, resultText = "" } = {}) {
  if (delivery.final === true) return null;
  if (Array.isArray(delivery.assignments) && delivery.assignments.length) return null;
  if (Array.isArray(delivery.choices) && delivery.choices.length) return null;
  if (Array.isArray(delivery.plan?.stages) && delivery.plan.stages.length) return null;
  const dropped = Array.isArray(delivery.droppedAssignments) ? delivery.droppedAssignments : [];
  if (dropped.length) {
    return { reason: "dropped_assignments", detail: dropped.map((item) => `${item.agentKey || "?"}（${item.reason}）`).join("、") };
  }
  const text = textOf(delivery, resultText);
  const match = text.match(DISPATCH_CLAIM);
  return match ? { reason: "verbal_claim", detail: match[0] } : null;
}

/**
 * 从文字中推断被点名的执行角色（只返回已注册、且不是项目经理自己的角色）。
 * @param {string} [text] @param {string[]} [availableKeys]
 */
export function inferDispatchTargets(text = "", availableKeys = []) {
  const available = new Set(availableKeys.filter((key) => key !== "project_manager"));
  const found = [];
  for (const [key, aliases] of Object.entries(ROLE_ALIASES)) {
    if (!available.has(key)) continue;
    if (text.includes(key) || aliases.some((alias) => text.includes(alias))) found.push(key);
  }
  return found;
}

/** @param {{ reason: string, detail: string }} detection @param {string[]} [availableKeys] */
export function dispatchCorrectionNote(detection, availableKeys = []) {
  const roles = availableKeys.filter((key) => key !== "project_manager").join("、");
  const cause = detection.reason === "dropped_assignments"
    ? `你提交的 assignments 全部无效被系统丢弃：${detection.detail}。`
    : `你在文字中写了“${detection.detail}”，但交付里没有有效的 assignments。`;
  return [
    `【派发纠正】${cause}文字里的“已派发/已交给”不会通知任何角色，任务会因此卡住。`,
    `请立即重新调用 deliver_artifact：需要其他角色时在 assignments 中逐个填写 agentKey（只能是：${roles}）和具体 task；`,
    "确实不需要派发时，删去派发说法，自己完成或设置 final=true 并如实说明。",
  ].join("\n");
}

// 粒度门禁：前端/后端的一条 assignment 应是一个可独立验收的切片（一个接口、一个页面或一个组件）。
// 只用可量化的信号判断“过大”：验收标准条数、任务描述长度、任务里罗列的条目数。
export const SLICE_LIMITS = {
  roles: ["frontend_developer", "backend_developer"],
  maxCriteria: Number(process.env.PI_SLICE_MAX_CRITERIA) || 5,
  maxTaskChars: Number(process.env.PI_SLICE_MAX_TASK_CHARS) || 800,
  maxListItems: Number(process.env.PI_SLICE_MAX_LIST_ITEMS) || 6,
};

const LIST_ITEM = /^\s*(?:\d+[.、)）]|[-*•·])\s*\S/;

/**
 * 找出明显过大的前端/后端 assignment。
 * @param {Array<any>} [assignments] @param {typeof SLICE_LIMITS} [limits]
 * @returns {Array<{ id: string, agentKey: string, reasons: string[] }>}
 */
export function oversizedAssignments(assignments = [], limits = SLICE_LIMITS) {
  const result = [];
  for (const item of Array.isArray(assignments) ? assignments : []) {
    if (!item || !limits.roles.includes(item.agentKey)) continue;
    const task = String(item.task || "");
    const criteria = Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.length : 0;
    const listItems = task.split(/\r?\n/).filter((line) => LIST_ITEM.test(line)).length;
    const reasons = [];
    if (criteria > limits.maxCriteria) reasons.push(`验收标准 ${criteria} 条（上限 ${limits.maxCriteria}）`);
    if (task.length > limits.maxTaskChars) reasons.push(`任务描述 ${task.length} 字（上限 ${limits.maxTaskChars}）`);
    if (listItems >= limits.maxListItems) reasons.push(`任务里罗列了 ${listItems} 个条目`);
    if (reasons.length) result.push({ id: item.id || item.agentKey, agentKey: item.agentKey, reasons });
  }
  return result;
}

/**
 * 同角色、没有依赖关系、却声明了重叠写入范围的切片对：它们本想并行，但会改到同一批文件，调度时只能退回串行。
 * @param {Array<any>} [assignments]
 * @returns {Array<{ agentKey: string, ids: [string, string] }>}
 */
export function overlappingSlices(assignments = []) {
  const items = (Array.isArray(assignments) ? assignments : []).filter((item) => item && writeScopeOf(item).length);
  const dependsOn = (a, b) => (Array.isArray(a.dependsOn) ? a.dependsOn : []).includes(b.id);
  /** @type {Array<{ agentKey: string, ids: [string, string] }>} */
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const [a, b] = [items[i], items[j]];
      if (a.agentKey !== b.agentKey || dependsOn(a, b) || dependsOn(b, a)) continue;
      if (writeScopesOverlap(writeScopeOf(a), writeScopeOf(b))) pairs.push({ agentKey: a.agentKey, ids: [a.id || a.agentKey, b.id || b.agentKey] });
    }
  }
  return pairs;
}

/**
 * @param {Array<{ id: string, agentKey: string, reasons: string[] }>} oversized
 * @param {Array<{ agentKey: string, ids: [string, string] }>} [overlaps]
 */
export function sliceCorrectionNote(oversized, overlaps = []) {
  const lines = [];
  if (oversized.length) {
    lines.push(
      `任务粒度校验未通过：${oversized.map((item) => `${item.id}（${item.agentKey}）${item.reasons.join("、")}`).join("；")}。`,
      "请把这些任务拆成多个切片：同一角色可以有多条 assignment，每条是一个可独立验收的接口、页面或组件，",
      "各自带唯一 id、1–3 条 acceptanceCriteria，有先后关系时用 dependsOn 指向前一片的 id。",
    );
  }
  if (overlaps.length) {
    lines.push(
      `写入范围重叠：${overlaps.map((item) => `${item.ids.join(" 与 ")}（${item.agentKey}）`).join("；")}。`,
      "同角色切片只有 fileWriteAllowlist 互不重叠（含父子目录）时才会并行；请重新划分写入范围，或用 dependsOn 明确先后，",
      "多个切片都要改的公共文件（路由注册、菜单、依赖等）放进一个依赖它们的集成切片。",
    );
  }
  lines.push("修正后重新调用 deliver_artifact；如果确实无法调整，原样再提交一次即可放行（重叠的切片会串行执行）。");
  return lines.join("\n");
}

const VERDICTS = new Set(["pass", "fail", "skip"]);
const CHECK_STATUSES = new Set(["pass", "fail", "skip"]);
const EVIDENCE_KINDS = new Set(["command", "file", "screenshot", "url", "note"]);
const clip = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * 校验并规整测试提交的结构化验收结果。
 * - verdict=pass：至少一项检查且全部 pass，并至少一条证据；
 * - verdict=fail：至少一项检查为 fail；
 * - verdict=skip：必须写明 skipReason（例如纯库项目没有可验收的界面或接口）。
 * @param {any} input
 * @returns {{ valid: boolean, errors: string[], acceptance: any }}
 */
export function validateAcceptance(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { valid: false, errors: ["缺少 acceptance 验收结果"], acceptance: null };
  const verdict = String(input.verdict || "").trim().toLowerCase();
  if (!VERDICTS.has(verdict)) errors.push("verdict 只能是 pass、fail 或 skip");
  const checks = (Array.isArray(input.checks) ? input.checks : []).slice(0, 30).map((check, index) => ({
    id: clip(check?.id || `C${index + 1}`, 40),
    title: clip(check?.title, 200),
    status: String(check?.status || "").trim().toLowerCase(),
    ...(check?.detail ? { detail: clip(check.detail, 500) } : {}),
  }));
  checks.forEach((check, index) => {
    if (!check.title) errors.push(`第 ${index + 1} 项检查缺少 title`);
    if (!CHECK_STATUSES.has(check.status)) errors.push(`检查 ${check.id} 的 status 只能是 pass、fail 或 skip`);
  });
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).slice(0, 20).map((item) => ({
    kind: String(item?.kind || "").trim().toLowerCase(),
    ...(item?.command ? { command: clip(item.command, 500) } : {}),
    ...(item?.status ? { status: clip(item.status, 30).toLowerCase() } : {}),
    ...(Number.isInteger(item?.exitCode) ? { exitCode: item.exitCode } : {}),
    ...(item?.path ? { path: clip(item.path, 500) } : {}),
    ...(item?.text ? { text: clip(item.text, 1000) } : {}),
    ...(item?.url ? { url: clip(item.url, 500) } : {}),
  }));
  evidence.forEach((item, index) => {
    if (!EVIDENCE_KINDS.has(item.kind)) errors.push(`第 ${index + 1} 条证据的 kind 只能是 command、file、screenshot、url 或 note`);
    else if ((item.kind === "file" || item.kind === "screenshot") && !item.path) errors.push(`第 ${index + 1} 条证据缺少 path`);
    else if (item.kind === "url" && !item.url) errors.push(`第 ${index + 1} 条证据缺少 url`);
    else if ((item.kind === "command" || item.kind === "note") && !item.text && !item.command) errors.push(`第 ${index + 1} 条证据缺少 text 或 command`);
  });
  const skipReason = clip(input.skipReason, 500);
  if (verdict === "pass") {
    if (!checks.length) errors.push("verdict=pass 至少需要一项检查");
    if (checks.some((check) => check.status !== "pass")) errors.push("verdict=pass 时所有检查都必须为 pass；有未通过或跳过的项请如实给出 fail 或说明");
    if (!evidence.length) errors.push("verdict=pass 至少需要一条证据（执行的命令与结果、测试报告文件或截图）");
  }
  if (verdict === "fail" && !checks.some((check) => check.status === "fail")) errors.push("verdict=fail 时至少有一项检查为 fail，并写明失败现象");
  if (verdict === "skip" && !skipReason) errors.push("verdict=skip 必须填写 skipReason");
  const acceptance = {
    verdict,
    summary: clip(input.summary, 500),
    checks,
    evidence,
    ...(skipReason ? { skipReason } : {}),
  };
  return { valid: errors.length === 0, errors, acceptance };
}

/** @param {any} acceptance @returns {Array<{ id: string, title: string, status: string, detail?: string }>} */
export function failedChecks(acceptance) {
  return (acceptance?.checks || []).filter((check) => check.status === "fail");
}

/** @param {any} acceptance */
export function acceptanceFailureNote(acceptance, acceptanceMatrix = []) {
  const failed = failedChecks(acceptance).map((check) => `- ${check.id} ${check.title}${check.detail ? `：${check.detail}` : ""}`).join("\n");
  const routing = acceptanceFailureRouting(acceptanceMatrix, acceptance);
  return [
    "【验收未通过】测试提交的结构化验收结论为 fail，以下检查未通过：",
    failed || "- （未列出具体检查项）",
    routing.length
      ? `必须按开发前验收矩阵回派：${routing.map((item) => `${item.id} → ${item.returnTo}`).join("；")}。`
      : "失败项没有匹配到验收矩阵中的责任人；请先补齐 returnTo，再决定修复角色。",
    "请据此决定：用 assignments 把具体缺陷派给对应开发角色修复，并在修复后安排测试重新验收；",
    "检查编号形如 <切片id>-AC<n> 时，前缀就是出问题的切片：只返工这些切片，不要整块重做。",
    "若判断为测试误判，请说明理由后继续推进。不要在未修复的情况下直接设置 final=true。",
  ].join("\n");
}

export const ACCEPTANCE_MISSING_NOTE = [
  "【验收纠正】你上一轮没有提交结构化验收结果。",
  "请重新调用 deliver_artifact，并填写 acceptance：verdict（pass/fail/skip）、checks（逐项检查及状态）、evidence（执行的命令与结果、报告文件或截图）。",
  "“单元测试通过”或“页面能打开”不能直接当作通过；没有可验收内容时用 verdict=skip 并写明 skipReason。",
].join("\n");
