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

// 同一角色有多个切片时，按角色索引的 assignmentTasks 只保留第一条；
// 切片自己的任务与权限由 dispatchTo 的 assignment 参数传入，这里只做兼容。
export function withAssignments(context, assignments = []) {
  const firstByRole = new Map();
  for (const item of assignments) if (!firstByRole.has(item.agentKey)) firstByRole.set(item.agentKey, item);
  return {
    ...context,
    selectedAgents: [...firstByRole.keys()],
    assignmentTasks: Object.fromEntries([...firstByRole].map(([key, item]) => [key, item.task])),
    assignmentPermissions: Object.fromEntries([...firstByRole].map(([key, item]) => [key, permissionsOf(item)])),
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
  const assignments = ensureAssignmentIds(Array.isArray(delivery.assignments) ? delivery.assignments : []);
  const architect = assignments.find((item) => item?.agentKey === ARCHITECT_KEY);
  const others = assignments.filter((item) => item && item.agentKey !== ARCHITECT_KEY);
  if (!architect || !others.length) return delivery;
  const architectId = architect.id || ARCHITECT_KEY;
  const design = { ...architect, id: architectId, dependsOn: [] };
  const followers = others.map((item) => ({
    ...item,
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
      acceptanceMatrix: Array.isArray(delivery.plan?.acceptanceMatrix) ? delivery.plan.acceptanceMatrix : [],
      autoSequenced: true,
    },
  };
}

// 任务切片：前端/后端的大任务由项目经理拆成多个可独立验收的切片（同一角色多条 assignment），
// 每个切片单独派发、单独交付；同一角色的切片共用一个工作区，写入范围互不重叠时才并行（见 scheduleByRole）。
export const SLICEABLE_ROLES = new Set(["frontend_developer", "backend_developer"]);

const safeId = (value) => String(value || "").trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// 补齐并去重 assignment id：只出现一次的角色沿用角色名作 id，重复的角色编号为 <角色>-1、<角色>-2。
export function ensureAssignmentIds(assignments = []) {
  const counts = new Map();
  for (const item of assignments) counts.set(item?.agentKey, (counts.get(item?.agentKey) || 0) + 1);
  const used = new Set();
  const ordinal = new Map();
  return assignments.map((item) => {
    if (!item) return item;
    const n = (ordinal.get(item.agentKey) || 0) + 1;
    ordinal.set(item.agentKey, n);
    const base = safeId(item.id) || (counts.get(item.agentKey) > 1 ? `${item.agentKey}-${n}` : item.agentKey);
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

// 扁平 assignments 有两条及以上时转成单阶段计划交给计划调度：依赖照常生效，同角色切片由 scheduleByRole
// 决定串行还是并行，全部交付后才交回项目经理汇总（扁平并行时先完成的一方就会触发汇总），
// 进度也会以 plan_progress 广播给桌面端。只有一条或已有计划时不改写。
export function sequenceRepeatedRoles(delivery) {
  if (!delivery || delivery.plan?.stages?.length) return delivery;
  const assignments = Array.isArray(delivery.assignments) ? delivery.assignments.filter(Boolean) : [];
  if (assignments.length < 2) return delivery;
  const slices = ensureAssignmentIds(assignments);
  return {
    ...delivery,
    assignments: slices,
    plan: {
      project: delivery.projectName || null,
      goal: String(delivery.summary || "").slice(0, 200),
      stages: [{ id: "slices", assignments: slices }],
      acceptanceCriteria: [],
      acceptanceMatrix: Array.isArray(delivery.plan?.acceptanceMatrix) ? delivery.plan.acceptanceMatrix : [],
      autoSequenced: true,
    },
  };
}

export function sequenceAssignments(delivery) {
  return sequenceRepeatedRoles(sequenceArchitectFirst(delivery));
}

// 同角色切片并行的唯一依据是写入范围：各自声明了 fileWriteAllowlist 且互不重叠（含父子目录）时才同时执行，
// 策略层会按该白名单拦截越界写入；没声明或有重叠就退回串行。并发数受 PI_MAX_PARALLEL_SLICES 限制。
export const MAX_PARALLEL_SLICES = Math.max(1, Number(process.env.PI_MAX_PARALLEL_SLICES) || 2);

const normalizeScope = (path) => String(path).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

export function writeScopeOf(assignment) {
  return (Array.isArray(assignment?.fileWriteAllowlist) ? assignment.fileWriteAllowlist : []).map(normalizeScope).filter(Boolean);
}

export function writeScopesOverlap(left = [], right = []) {
  return left.map(normalizeScope).some((a) => right.map(normalizeScope).some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function canRunAlongside(assignment, peers) {
  if (!peers.length) return true;
  const scope = writeScopeOf(assignment);
  return scope.length > 0 && peers.every((peer) => {
    const other = writeScopeOf(peer);
    return other.length > 0 && !writeScopesOverlap(scope, other);
  });
}

// 从候选里挑出本轮可以启动的 assignment：running 是各角色正在执行的切片。
export function scheduleByRole(candidates = [], running = [], { maxParallel = MAX_PARALLEL_SLICES } = {}) {
  const lanes = new Map();
  for (const item of running) lanes.set(item.agentKey, [...(lanes.get(item.agentKey) || []), item]);
  const picked = [];
  for (const item of candidates) {
    if (!item) continue;
    const peers = lanes.get(item.agentKey) || [];
    if (peers.length >= maxParallel || !canRunAlongside(item, peers)) continue;
    lanes.set(item.agentKey, [...peers, item]);
    picked.push(item);
  }
  return picked;
}

// 切片在计划中的位置，用于提示下游“只做这一片”。同角色只有一个 assignment 时返回 null。
export function sliceInfoFor(plan, assignment) {
  if (!plan || !assignment?.id) return null;
  const peers = (plan.stages || []).flatMap((stage) => stage.assignments || []).filter((item) => item.agentKey === assignment.agentKey);
  if (peers.length < 2) return null;
  return {
    id: assignment.id,
    index: peers.findIndex((item) => item.id === assignment.id) + 1,
    total: peers.length,
    others: peers.filter((item) => item.id !== assignment.id).map((item) => `${item.id}：${String(item.task || "").slice(0, 80)}`),
  };
}

// 同一角色拆成多个子机器人时，用稳定的中文序号区分实例；单实例保持原角色名。
export function agentInstanceLabel(displayName, slice) {
  const index = Number(slice?.index);
  const total = Number(slice?.total);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 2) return displayName;
  return `${index}号${displayName}`;
}
