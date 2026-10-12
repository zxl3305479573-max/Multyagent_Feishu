// @ts-check
// 把项目经理（或计划中就绪阶段）的 assignments 写进派发上下文：
// 下游角色据此知道“谁被选中、各自做什么、权限白名单是什么”。
export function permissionsOf(assignment = {}) {
  return {
    toolAllowlist: assignment.toolAllowlist || [],
    fileReadAllowlist: assignment.fileReadAllowlist || [],
    fileWriteAllowlist: assignment.fileWriteAllowlist || [],
    networkPolicy: assignment.networkPolicy || { enabled: false, domains: [] },
  };
}

export function withAssignments(context, assignments = []) {
  return {
    ...context,
    selectedAgents: assignments.map((item) => item.agentKey),
    assignmentTasks: Object.fromEntries(assignments.map((item) => [item.agentKey, item.task])),
    assignmentPermissions: Object.fromEntries(assignments.map((item) => [item.agentKey, permissionsOf(item)])),
  };
}

// 回交项目经理或桌面端发起的新一轮时，清空上一阶段的派发清单。
export function withoutAssignments(context) {
  return { ...context, selectedAgents: [], assignmentTasks: {}, assignmentPermissions: {} };
}

// 架构先行：项目经理在扁平 assignments 里同时选了架构设计师和其他执行角色时，
// 自动拆成两阶段计划——先由架构设计师产出架构设计，交付后再派发其余角色。
// 是否需要架构设计师仍由项目经理自主判断；这里只保证“选了架构就先做架构”。
// 项目经理已显式提交 plan 时尊重其阶段安排，不做改写。
export const ARCHITECT_KEY = "architect";

export function sequenceArchitectFirst(delivery) {
  if (!delivery || delivery.plan?.stages?.length) return delivery;
  const assignments = Array.isArray(delivery.assignments) ? delivery.assignments : [];
  const architect = assignments.find((item) => item?.agentKey === ARCHITECT_KEY);
  const others = assignments.filter((item) => item && item.agentKey !== ARCHITECT_KEY);
  if (!architect || !others.length) return delivery;
  const architectId = architect.id || ARCHITECT_KEY;
  const design = { ...architect, id: architectId, dependsOn: [] };
  const followers = others.map((item) => ({
    ...item,
    id: item.id || item.agentKey,
    dependsOn: [...new Set([...(Array.isArray(item.dependsOn) ? item.dependsOn : []), architectId])],
  }));
  return {
    ...delivery,
    assignments: [design],
    plan: {
      project: delivery.projectName || null,
      goal: String(delivery.summary || "").slice(0, 200),
      stages: [
        { id: "architecture", assignments: [design] },
        { id: "implementation", assignments: followers },
      ],
      acceptanceCriteria: [],
      autoSequenced: true,
    },
  };
}
