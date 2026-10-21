// Agent 可调用的受控工具：交付产物、创建项目、查询任务状态、受控 CLI。
import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deliveryNameFor, ensureArtifactsDir, saveDelivery } from "../artifacts.js";
import { readProjectSummary } from "../project-summary.js";
import { sanitizeAgentReply } from "./prompts.js";
import { executeAgentCli } from "../agent-cli.js";
import { loadTaskStatus } from "../task-status.js";
import { validateTaskPlan } from "../task-plan.js";
import { roleConfig } from "../role-config.cjs";
import { getCapabilityRegistry } from "../capabilities/index.js";
import { overlappingSlices, oversizedAssignments, sliceCorrectionNote, validateAcceptance } from "../orchestrator/guards.js";
import { SLICEABLE_ROLES } from "../orchestrator/assignments.js";
import { acquireProjectLock } from "../runtime/project-lock.js";
import { resolveProjectFile } from "../project-file.cjs";

const loadedRoleConfig = roleConfig();
const agentsConfig = { agents: loadedRoleConfig.agents };
const planPolicies = loadedRoleConfig.policy.agents;

function projectPaths(paths, projectName) {
  const project = String(projectName || "default");
  return (Array.isArray(paths) ? paths : []).map((path) => String(path).replaceAll("{project}", project));
}

/**
 * 结构化计划校验使用“所有角色”的权限上限，而不是项目经理自己的上限。
 * 用户给角色安装的插件工具也属于该角色当前可用的工具，否则计划里的插件调用会被误拒绝。
 */
export function buildTaskPlanRoleLimits(projectName, registry = getCapabilityRegistry()) {
  return Object.fromEntries(agentsConfig.agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => {
      const limits = planPolicies[agent.key] || {};
      const capabilities = registry?.forRole?.(agent.key) || {};
      const pluginTools = capabilities.tools || [];
      const baseTools = capabilities.baseTools || limits.tools || [];
      return [agent.key, {
        tools: [...new Set([...baseTools, ...pluginTools])],
        readPaths: projectPaths(limits.writePaths, projectName),
        writePaths: projectPaths(limits.writePaths, projectName),
        networkAccess: limits.networkAccess === true,
        networkDomains: Array.isArray(limits.networkDomains) ? limits.networkDomains : [],
      }];
    }));
}

// 测试的结构化验收结果；证据里的文件/截图必须真实存在于当前项目目录。
async function checkAcceptance(input, { root, projectName }) {
  const checked = validateAcceptance(input);
  if (!checked.valid || !projectName) return checked;
  const errors = [];
  for (const item of checked.acceptance.evidence) {
    if (item.kind !== "file" && item.kind !== "screenshot") continue;
    try { await resolveProjectFile(root, projectName, item.path); }
    catch (error) { errors.push(`证据文件 ${item.path} 不可用：${error.message}`); }
  }
  return errors.length ? { ...checked, valid: false, errors } : checked;
}

export function createDeliverTool({ getArtifactsDir, getProjectName, agentKey, agentName, taskId = null, roleLimits = {}, onDeliver, root = process.cwd() }) {
  const limitsForPlan = () => typeof roleLimits === "function"
    ? roleLimits()
    : Object.keys(roleLimits || {}).length
      ? roleLimits
      : buildTaskPlanRoleLimits(getProjectName?.() || null);
  // 粒度门禁每次运行只拦一次：项目经理确认无法再拆时，原样再提交即放行，避免卡死。
  let sliceGateTriggered = false;
  return defineTool({
    name: "deliver_artifact",
    label: "交付产物",
    description: "完成任务后交付：提交摘要、产物路径、假设和下一步建议。交付后任务才算完成。",
    parameters: Type.Object({
      summary: Type.String({ description: "交付摘要（必填，需包含：结论 + 关键决策 + 产物内容要点，让人不看文件也能判断成果）" }),
      artifactPaths: Type.Optional(Type.Array(Type.String(), { description: "产物文件路径列表" })),
      artifactItems: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ description: "交付文件路径，必须与 artifactPaths 中的路径一致" }),
        description: Type.String({ description: "说明文件内容、用途和本次交付中的作用" }),
      }), { description: "逐个说明每个交付文件的内容和用途" })),
      next: Type.Optional(Type.String({ description: "建议的下一步" })),
      blockers: Type.Optional(Type.Array(Type.String(), { description: "当前无法继续推进的阻塞项；没有则传空数组" })),
      assumptions: Type.Optional(Type.Array(Type.String(), { description: "未确认的假设" })),
      risks: Type.Optional(Type.Array(Type.String(), { description: "需跟踪的风险；没有则传空数组" })),
      choices: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        label: Type.String(),
        description: Type.Optional(Type.String()),
        primary: Type.Optional(Type.Boolean()),
      }), { description: "需要用户点击选择的选项列表" })),
      final: Type.Optional(Type.Boolean({ description: "是否为最终交付（汇总完成、无需下游协作）。默认为 false" })),
      assignments: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String({ description: "切片唯一 id，例如 fe-login-page；同一角色有多条 assignment 时必填" })),
        agentKey: Type.String(),
        task: Type.String({ description: "一个可独立验收的切片：一个接口、一个页面或一个组件" }),
        reason: Type.Optional(Type.String()),
        integration: Type.Optional(Type.Boolean({ description: "是否为最终集成验证切片；多切片计划必须且只能有一个，由 tester 依赖全部工作切片执行" })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "该切片的 1–3 条验收标准" })),
        dependsOn: Type.Optional(Type.Array(Type.String(), { description: "必须先完成的切片 id" })),
        fileWriteAllowlist: Type.Optional(Type.Array(Type.String(), { description: "该切片允许写入的路径（目录或文件，例如 workspace/<项目>/frontend/src/pages/login）；同角色切片互不重叠时才会并行" })),
      }), { description: "派发给其他角色的任务。前端/后端的大任务拆成多条切片，同一角色的切片按顺序依次执行" })),
      plan: Type.Optional(Type.Any({ description: "项目经理使用的结构化阶段计划；包含 project、goal、stages 和权限快照" })),
      acceptance: Type.Optional(Type.Object({
        verdict: Type.String({ description: "pass | fail | skip。单元测试通过或页面能打开不等于 pass" }),
        summary: Type.Optional(Type.String({ description: "一两句验收结论" })),
        checks: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: "检查编号，例如 AC1" })),
          title: Type.String({ description: "检查点，对应需求或验收标准" }),
          status: Type.String({ description: "pass | fail | skip" }),
          detail: Type.Optional(Type.String({ description: "实际现象；失败时写清复现步骤" })),
        }), { description: "逐项检查结果" }),
        evidence: Type.Optional(Type.Array(Type.Object({
          kind: Type.String({ description: "command | file | screenshot | url | note" }),
          command: Type.Optional(Type.String({ description: "实际执行的完整命令，例如 npm test" })),
          status: Type.Optional(Type.String({ description: "命令或检查结果：pass | fail" })),
          exitCode: Type.Optional(Type.Integer({ description: "命令真实退出码；通过必须为 0" })),
          path: Type.Optional(Type.String({ description: "file/screenshot 的项目内路径" })),
          text: Type.Optional(Type.String({ description: "command/note：执行的命令与结果摘要" })),
          url: Type.Optional(Type.String()),
        }), { description: "验收证据" })),
        skipReason: Type.Optional(Type.String({ description: "verdict=skip 时必填" })),
      }, { description: "测试必填：结构化验收结果。其他角色不要填写" })),
      diagram: Type.Optional(Type.Object({
        title: Type.Optional(Type.String({ description: "流程图标题" })),
        nodes: Type.Array(Type.Object({
          id: Type.String({ description: "节点唯一 id，供连线引用" }),
          label: Type.String({ description: "方框里的文字，尽量短" }),
          layer: Type.Optional(Type.String({ description: "所属层/分组，同层节点并排显示，例如：接入层、服务层、数据层" })),
        }), { description: "节点列表" }),
        edges: Type.Array(Type.Object({
          from: Type.String({ description: "起点节点 id" }),
          to: Type.String({ description: "终点节点 id" }),
          label: Type.Optional(Type.String({ description: "连线上的文字，例如协议或操作名" })),
        }), { description: "连线列表" }),
      }, { description: "系统架构流程图：有架构内容时填写，会渲染成图片放进飞书卡片" })),
    }),
    async execute(_toolCallId, params) {
      const artifactsDir = getArtifactsDir();
      let plan = null;
      if (params.plan !== undefined) {
        if (agentKey !== "project_manager") {
          return { content: [{ type: "text", text: "计划校验失败：只有项目经理可以提交结构化阶段计划" }], details: {} };
        }
        const checked = validateTaskPlan(params.plan, { projectName: getProjectName?.() || null, roleLimits: limitsForPlan() });
        if (!checked.valid) {
          return { content: [{ type: "text", text: `计划校验失败：${checked.errors.join("；")}` }], details: { planErrors: checked.errors } };
        }
        plan = checked.plan;
      }
      let acceptance = null;
      if (agentKey === "tester") {
        const checked = await checkAcceptance(params.acceptance, { root, projectName: getProjectName?.() || null });
        if (!checked.valid) {
          return { content: [{ type: "text", text: `验收结果校验失败：${checked.errors.join("；")}。请修正 acceptance 后重新调用 deliver_artifact。` }], details: { acceptanceErrors: checked.errors } };
        }
        acceptance = checked.acceptance;
      }
      const rawAssignments = params.assignments || (plan?.stages?.[0]?.assignments || []);
      let granularityWarnings = [];
      if (agentKey === "project_manager" && params.final !== true) {
        // 计划首阶段通常与 assignments 重复，按 id 合并后再检查，避免同一切片报两次。
        const planned = plan ? plan.stages.flatMap((stage) => stage.assignments) : [];
        const merged = new Map();
        for (const item of [...(Array.isArray(params.assignments) ? params.assignments : []), ...planned]) {
          if (item) merged.set(item.id || `${item.agentKey}|${item.task}`, item);
        }
        const candidates = [...merged.values()];
        const oversized = oversizedAssignments(candidates);
        const overlaps = overlappingSlices(candidates);
        if ((oversized.length || overlaps.length) && !sliceGateTriggered) {
          sliceGateTriggered = true;
          return { content: [{ type: "text", text: sliceCorrectionNote(oversized, overlaps) }], details: { oversizedAssignments: oversized, overlappingSlices: overlaps } };
        }
        granularityWarnings = [...oversized, ...overlaps.map((item) => ({ id: item.ids.join("+"), agentKey: item.agentKey, reasons: ["写入范围重叠，将串行执行"] }))];
      }
      const delivery = {
        summary: sanitizeAgentReply(params.summary),
        artifactPaths: params.artifactPaths || [],
        artifactItems: Array.isArray(params.artifactItems) ? params.artifactItems.filter((item) => item?.path && item?.description).map((item) => ({ path: String(item.path), description: sanitizeAgentReply(item.description) })) : [],
        next: params.next || "",
        blockers: params.blockers || [],
        assumptions: params.assumptions || [],
        risks: params.risks || [],
        choices: params.choices || [],
        assignments: normalizeAssignments(rawAssignments, { selfAgentKey: agentKey, allowDispatch: agentKey === "project_manager" }),
        droppedAssignments: agentKey === "project_manager" ? droppedAssignments(rawAssignments, { selfAgentKey: agentKey }) : [],
        granularityWarnings,
        // 本次运行是否被粒度门禁打回过（切片统计用）。
        sliceGateRejected: sliceGateTriggered,
        acceptance,
        plan,
        diagram: params.diagram || null,
        final: params.final === true,
        artifactsDir,
        projectName: getProjectName?.() || null,
        agentKey,
        agentName,
      };
      await saveDelivery(artifactsDir, agentKey, delivery, { deliveryName: deliveryNameFor(agentKey, taskId) });
      await onDeliver?.(delivery);
      return {
        content: [{ type: "text", text: `已交付：${sanitizeAgentReply(params.summary)}` }],
        details: {},
      };
    },
  });
}

// 被 normalizeAssignments 过滤掉的派发项及原因；编排层据此识别“给了派发却全部无效”的情况。
// 单次派发上限：最多 maxRoles 个不同角色；前端/后端可拆成多个切片，切片总数不超过 maxAssignments。
export const MAX_DISPATCH_ROLES = 3;
export const MAX_DISPATCH_ASSIGNMENTS = Number(process.env.PI_MAX_ASSIGNMENTS) || 6;

// 同一角色重复出现时，只有前端/后端的不同切片（不同 id 或不同任务）才算有效。
function assignmentKey(item) {
  if (!SLICEABLE_ROLES.has(item.agentKey)) return item.agentKey;
  return `${item.agentKey}|${String(item.id || "").trim() || item.task.trim()}`;
}

function screenAssignments(value, { selfAgentKey, maxRoles, maxAssignments }) {
  const allowed = new Set(agentsConfig.agents.map((agent) => agent.key));
  const seen = new Set();
  const roles = new Set();
  return (Array.isArray(value) ? value : []).map((item) => {
    const agentKey = item && typeof item.agentKey === "string" ? item.agentKey : "";
    let reason = "";
    if (!allowed.has(agentKey)) reason = "未知角色";
    else if (agentKey === selfAgentKey) reason = "不能派给自己";
    else if (typeof item.task !== "string" || !item.task.trim()) reason = "缺少 task";
    else if (seen.has(assignmentKey(item))) reason = "重复派发";
    else if (!roles.has(agentKey) && roles.size >= maxRoles) reason = `超过单次 ${maxRoles} 个角色上限`;
    else if (seen.size >= maxAssignments) reason = `超过单次 ${maxAssignments} 个切片上限`;
    if (!reason) { seen.add(assignmentKey(item)); roles.add(agentKey); }
    return { item, agentKey, reason };
  });
}

export function droppedAssignments(value, { selfAgentKey = null, maxRoles = MAX_DISPATCH_ROLES, maxAssignments = MAX_DISPATCH_ASSIGNMENTS } = {}) {
  return screenAssignments(value, { selfAgentKey, maxRoles, maxAssignments })
    .filter((entry) => entry.reason)
    .map((entry) => ({ agentKey: entry.agentKey || "?", reason: entry.reason }));
}

export function normalizeAssignments(value, { selfAgentKey = null, maxRoles = MAX_DISPATCH_ROLES, maxAssignments = MAX_DISPATCH_ASSIGNMENTS, allowDispatch = true } = {}) {
  if (!allowDispatch) return [];
  if (!Array.isArray(value)) return [];
  return screenAssignments(value, { selfAgentKey, maxRoles, maxAssignments })
    .filter((entry) => !entry.reason)
    .map(({ item }) => ({
      ...(item.id ? { id: String(item.id).trim() } : {}),
      agentKey: item.agentKey,
      task: item.task.trim(),
      reason: typeof item.reason === "string" ? item.reason.trim() : "",
      ...(item.integration === true ? { integration: true } : {}),
      ...(Array.isArray(item.dependsOn) ? { dependsOn: item.dependsOn.filter((dependency) => typeof dependency === "string") } : {}),
      ...(Array.isArray(item.acceptanceCriteria) ? { acceptanceCriteria: item.acceptanceCriteria.filter((criterion) => typeof criterion === "string" && criterion.trim()).map((criterion) => criterion.trim()) } : {}),
      ...(Array.isArray(item.toolAllowlist) ? { toolAllowlist: item.toolAllowlist.filter((tool) => typeof tool === "string") } : {}),
      ...(Array.isArray(item.fileReadAllowlist) ? { fileReadAllowlist: item.fileReadAllowlist.filter((path) => typeof path === "string") } : {}),
      ...(Array.isArray(item.fileWriteAllowlist) ? { fileWriteAllowlist: item.fileWriteAllowlist.filter((path) => typeof path === "string") } : {}),
      ...(item.networkPolicy && typeof item.networkPolicy === "object" ? { networkPolicy: item.networkPolicy } : {}),
    }));
}

// 已有项目（含桌面端创建的），写进工具说明，飞书端项目经理据此复用而不是另起同义新项目。
function existingProjects(root) {
  try {
    return readdirSync(join(root, "workspace"), { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^[a-z][a-z0-9-]*$/.test(entry.name))
      .map((entry) => entry.name).sort().slice(0, 50);
  } catch {
    return [];
  }
}

export function createProjectTool({ onProject, root = process.cwd() }) {
  const known = existingProjects(root);
  return defineTool({
    name: "create_project",
    label: "创建项目",
    description: `确认英文项目名后调用：创建或切换到 workspace/<项目名>/ 项目目录。${known.length ? `已有项目：${known.join("、")}；用户提到的是已有项目时直接用原名切换。` : ""}`,
    parameters: Type.Object({
      name: Type.String({ description: "英文项目名：小写字母开头，仅含小写字母、数字、连字符" }),
    }),
    async execute(_toolCallId, params) {
      const name = String(params.name || "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        return { content: [{ type: "text", text: `项目名 "${name}" 无效。需小写字母开头，仅含小写字母、数字、连字符，例如 phone-login。` }], details: {} };
      }
      await ensureArtifactsDir(join(root, "workspace", name));
      onProject?.(name);
      let summary = null;
      try { summary = await readProjectSummary({ root, projectName: name }); } catch {}
      const text = summary?.content
        ? `项目 ${name} 已就绪（workspace/${name}/）。检测到历史项目摘要，请先读取并延续以下上下文：\n\n${summary.content}`
        : `项目 ${name} 已就绪（workspace/${name}/）。新项目暂无历史摘要。`;
      return { content: [{ type: "text", text }], details: { projectSummary: summary?.path || null } };
    },
  });
}

export function createTaskStatusTool({ taskId, chatId }) {
  return defineTool({
    name: "get_task_status",
    label: "查询任务状态",
    description: "只读查询当前群内指定根任务及其下游任务的结构化状态，不读取其他群或原始会话内容。",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "要查询的根任务编号；省略时查询当前任务" })),
    }),
    async execute(_toolCallId, params) {
      const requested = String(params.taskId || taskId || "").trim();
      if (!requested) return { content: [{ type: "text", text: "当前没有可查询的任务编号。" }], details: {} };
      const status = await loadTaskStatus(requested, chatId);
      return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
    },
  });
}

function resolveTaskFile(root) {
  const configured = process.env.PI_DOMAIN_TASKS_FILE || "runtime/domain-tasks.json";
  return isAbsolute(configured) ? configured : join(root, configured);
}

export function createAgentCliTool({ taskId, projectName, getProjectName, chatId, agentKey, root = process.cwd(), execute = executeAgentCli, acquireLock = acquireProjectLock }) {
  return defineTool({
    name: "agent_cli",
    label: "受控 CLI",
    description: "执行受控确定性操作并返回精简 JSON。action 只能是 test、task-status、validate-delivery 或 render-diagram；不支持任意 shell 命令。",
    parameters: Type.Object({
      action: Type.String({ description: "test | task-status | validate-delivery | render-diagram | bitable-check" }),
      command: Type.Optional(Type.String({ description: "test 使用的可执行文件，默认 node" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "test 命令参数数组" })),
      taskId: Type.Optional(Type.String({ description: "任务编号，默认当前任务" })),
      projectName: Type.Optional(Type.String({ description: "项目名，默认当前项目" })),
      artifactPaths: Type.Optional(Type.Array(Type.String(), { description: "交付文件路径列表" })),
      diagramJson: Type.Optional(Type.String({ description: "render-diagram 使用的图表 JSON" })),
    }),
    async execute(_toolCallId, params) {
      const action = String(params.action || "").trim();
      const allowedActions = new Set(["test", "task-status", "validate-delivery", "render-diagram", "bitable-check"]);
      if (!allowedActions.has(action)) {
        const result = { status: "failed", error: `unsupported agent CLI action: ${action}` };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      const effectiveTaskId = params.taskId || taskId;
      const effectiveProject = params.projectName || getProjectName?.() || projectName;
      const input = {
        root,
        taskId: effectiveTaskId,
        projectName: effectiveProject,
        chatId,
        agent: agentKey,
        artifactPaths: params.artifactPaths || [],
        ...(action === "render-diagram" ? { spec: params.diagramJson } : {}),
        ...(action === "test" ? { command: process.execPath, args: ["--test", "test"], cwd: root } : {}),
        ...(action === "task-status" ? { taskFile: resolveTaskFile(root) } : {}),
      };
      if (action === "render-diagram") {
        try {
          input.spec = JSON.parse(params.diagramJson || "{}");
        } catch {
          const result = { status: "failed", error: "diagramJson must be valid JSON" };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      }
      // 测试与并行切片的构建、安装共用项目级锁，避免同时跑互相干扰（见 runtime/project-lock.js）。
      const lock = action === "test" && process.env.PI_PROJECT_LOCK !== "false"
        ? await acquireLock({ root, project: effectiveProject, owner: agentKey || "" })
        : null;
      let result;
      try { result = await execute(action, input); } finally { await lock?.release(); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
