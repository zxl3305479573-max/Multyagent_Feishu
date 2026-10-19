// @ts-check
// 协作守卫：把“Agent 说了”与“Agent 真的提交了结构化信号”区分开。
//
// 派发守卫：项目经理只有在 deliver_artifact 里给出有效 assignments 才会真正派发。
//    它若只在文字里写“已派发给前端”，或给出的 assignments 全部无效被过滤，任务会悄悄卡住。
//    这里识别这两种情况，由编排层先纠正一次、仍失败再按文字推断兜底。

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
