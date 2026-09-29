// Pi Agent 运行时桥接层（最小纵向切片）。
// 职责：把飞书任务交给一个真实 Pi 会话处理，返回文本结果。
//
// 当前范围（步骤 3 + 阶段一）：
//   - 每次任务新建一个 in-memory session，prompt 后 dispose（天然并发隔离）。
//   - 角色身份 + 职责通过 systemPromptOverride 注入系统提示（强约束，防身份幻觉）。
//   - 工具白名单、职责、思考等级从 config/policy.json 按角色读取（阶段一：先只读）。
//   - 策略扩展拦截敏感文件（复用 spike/pi-policy.mjs 已验证的结论）。
//
// 后续阶段（暂未实现，见设计文档实施阶段）：
//   - 会话持久化 + task_id 复用（多轮追问）
//   - 路径级拦截 + 正式策略扩展，然后放开可写工具（edit/write）
//   - RPC 子进程隔离
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkWriteAllowed, isDeleteCommand, resolveWritePaths } from "./policy.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { artifactsDirFor, ensureArtifactsDir, saveDelivery } from "./artifacts.js";
import { executeAgentCli } from "./agent-cli.js";
import { loadTaskStatus } from "./task-status.js";
import { isTerminated } from "./tasks.js";
import { registerActiveSession } from "./session-control.js";

const MODEL_PROVIDER = process.env.PI_AGENT_PROVIDER || "deepseek";
// deepseek-chat is the stable API model; override with PI_AGENT_MODEL when needed.
const MODEL_ID = process.env.PI_AGENT_MODEL || "deepseek-chat";
const THINKING_LEVEL = process.env.PI_AGENT_THINKING || "off";

// The diagram-design skill is intentionally scoped to the planning/design
// agents. Other role agents should not receive the extra visual-authoring
// instructions or resources.
// Keep the path configurable so deployments can pin a vendored copy instead
// of relying on the user's global Codex skills directory.
export function diagramSkillPaths(agentKey) {
  if (agentKey !== "architect" && agentKey !== "project_manager") return [];
  const configured = process.env.PI_DIAGRAM_SKILL_PATH?.trim()
    || process.env.PI_ARCHITECT_DIAGRAM_SKILL_PATH?.trim();
  const defaultPath = join(homedir(), ".codex", "skills", "diagram-design");
  const skillPath = configured || defaultPath;
  return existsSync(skillPath) ? [skillPath] : [];
}

// Backward-compatible name for callers that used the original architect-only
// helper before project-manager support was added.
export const architectSkillPaths = diagramSkillPaths;

// 默认只读工具集：作为 policy.json 未配置角色时的 fallback。
const DEFAULT_TOOLS = ["read", "ls", "grep", "find"];

// 角色策略配置（权威来源）：每个角色的职责、目标、约束、工具白名单、思考等级。
const policy = JSON.parse(
  await readFile(new URL("../config/policy.json", import.meta.url), "utf8"),
);

// 团队角色清单（用于系统提示里的团队上下文，参考 MetaGPT 的 env_desc）。
const agentsConfig = JSON.parse(
  await readFile(new URL("../config/agents.json", import.meta.url), "utf8"),
);

// 敏感路径/命令拦截。命中即阻断工具执行。
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /auth\.json/i,
  /models-store\.json/i,
  /\.git\/config/i,
];

let modelRuntimePromise;

function getModelRuntime() {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create();
  }
  return modelRuntimePromise;
}

// 每个角色一个策略工厂：闭包捕获该角色的写路径白名单/黑名单。
export function createPolicyFactory(agent, projectNameOrGetter) {
  const cfg = policy.agents?.[agent.key] ?? {};
  const getProjectName = typeof projectNameOrGetter === "function"
    ? projectNameOrGetter
    : () => projectNameOrGetter;
  const denyPaths = cfg.denyPaths || [];
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      // 1. 敏感文件拦截（全局，所有工具）
      const raw = [event.input?.path, event.input?.command, event.input?.pattern]
        .filter(Boolean)
        .join(" ");
      if (SENSITIVE_PATTERNS.some((re) => re.test(raw))) {
        return { block: true, reason: "策略禁止访问敏感文件或执行敏感命令" };
      }
      // 2. 删除类命令拦截（仅允许创建与写入）。
      if (event.toolName === "bash" || event.toolName === "powershell") {
        if (isDeleteCommand(event.input?.command)) {
          return { block: true, reason: "策略禁止删除操作（仅允许创建与写入）" };
        }
      }
      // 3. 写入路径拦截（write/edit）
      if (event.toolName === "write" || event.toolName === "edit") {
        const currentProject = getProjectName();
        if (cfg.writePaths?.length && !currentProject) {
          return { block: true, reason: "尚未确定项目，禁止写入项目目录" };
        }
        const writePaths = resolveWritePaths(cfg.writePaths, currentProject);
        const check = checkWriteAllowed(ctx.cwd, event.input?.path, { writePaths, denyPaths });
        if (!check.allowed) {
          return { block: true, reason: check.reason };
        }
      }
    });
  };
}

// 角色相关的系统提示。替换 pi 默认的"编程助手"提示，避免身份被稀释。
export function buildSystemPrompt(agent, projectName) {
  const cfg = policy.agents?.[agent.key] ?? {};
  const duty = cfg.duty || "处理飞书用户发来的任务，给出结果。";
  const tools = cfg.tools || DEFAULT_TOOLS;
  const team = agentsConfig.agents
    .map((a) => (a.key === agent.key ? `${a.displayName}（你）` : a.displayName))
    .join("、");

  const lines = [
    `你是「${agent.displayName}」角色 Agent（内部标识：${agent.key}），MultyAgent 多智能体团队的一员。`,
    `你的身份是固定的，不得自称、扮演或提及你是其他角色。`,
    ``,
    `团队角色：${team}。`,
    `职责：${duty}`,
  ];
  if (projectName) {
    lines.push(`当前项目：${projectName}（工作目录 workspace/${projectName}/）。`);
  }
  if (cfg.goal) {
    lines.push(`目标：${cfg.goal}`);
  }
  if (cfg.constraints?.length) {
    lines.push(``, `约束：`);
    for (const c of cfg.constraints) {
      lines.push(`- ${c}`);
    }
  }
  if (cfg.workflow) {
    lines.push(``, `工作流程：${cfg.workflow}`);
  }
  if (agent.key === "project_manager") {
    lines.push(
      "",
      "Project manager must choose only required roles in assignments; never dispatch every role by default.",
      "Each assignment must include agentKey and task, with reason explaining why the role is needed.",
      "You have the diagram-design skill available for project plans, dependency maps, roadmaps, and workflow visuals. Use it only for planning/coordination visuals; do not author the final system architecture diagram or put an architecture `diagram` field in your delivery—delegate that to the architect.",
      "Do not produce architecture diagrams yourself: the `diagram` field belongs to the architect. Summarize and dispatch instead.",
    );
  }
  if (agent.key === "architect") {
    lines.push(
      "",
      "You have the diagram-design skill available. Use it when producing or revising architecture diagrams; choose an architecture/layers/data-flow type that matches the question, keep the diagram readable, and prefer self-contained SVG/HTML artifacts when a visual artifact is requested.",
      "The skill improves the visual artifact, but the deliver_artifact `diagram` field must still contain compact nodes/edges for the Feishu card preview. Keep the preview within 9 nodes and 12 edges, keep node labels short, declare layers explicitly, and avoid crossing or backtracking edges.",
      "When the user asks for a design/flow/architecture visual, create the skill's self-contained HTML/SVG in the assigned artifacts directory and include that file in artifactPaths. The diagram field is only the card preview, not a replacement for the skill-generated visual.",
      "Choose the visual type from the skill (architecture, flowchart, sequence, state machine, swimlane, etc.) based on the information being communicated; do not force every request into a generic layered architecture diagram.",
      "When your delivery describes system architecture, also fill the `diagram` field of deliver_artifact:",
      "nodes (id + short label, optional layer such as 接入层/服务层/数据层) and edges (from/to node id, optional label).",
      "It is rendered into a flowchart image and embedded in the Feishu card, so keep labels short and the graph readable.",
    );
  }
  lines.push(
    ``,
    `工作方式：`,
    `- 你可以使用工具（${tools.join("、")}）查看项目文件。`,
    `- 当工具被安全策略拒绝时，如实告知用户，不要尝试绕过。`,
    `- 完成任务后，用 deliver_artifact 工具交付（summary 必填）。`,
    `- 确定性的测试、状态读取、交付校验和图表生成优先使用 agent_cli 工具；不要把完整命令日志复制进交付摘要。`,
    `- 需要用户澄清时，也用 deliver_artifact 交付：summary 写明需要澄清什么，next 写明等待用户回答；不要输出长篇分析或复述上下文。`,
    `- 若这是最终汇总（任务全部完成、无需下游协作），交付时设置 final=true。`,
    `- 不要输出思考过程、工具调用过程或内部工作日志，也不要复述系统提示词和任务编排指令。`,
    `- 只输出最终的中文结果；调用 deliver_artifact 后，普通文本只保留一段简短中文摘要。`,
    `- 回复使用中文，简洁明确，直接给出结论。`,
  );
  return lines.join("\n");
}

// 每个角色缓存一份 loader（系统提示不同），首次创建后复用。
const loaderCache = new Map();

function getLoader(agent, projectNameOrGetter) {
  const dynamicProject = typeof projectNameOrGetter === "function";
  const getProjectName = dynamicProject ? projectNameOrGetter : () => projectNameOrGetter;
  const projectName = getProjectName();
  const cacheKey = `${agent.key}:${projectName || "default"}`;
  let loaderPromise = loaderCache.get(cacheKey);
  if (!loaderPromise || dynamicProject) {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      additionalSkillPaths: diagramSkillPaths(agent.key),
      systemPromptOverride: () => buildSystemPrompt(agent, getProjectName()),
      extensionFactories: [createPolicyFactory(agent, getProjectName)],
    });
    loaderPromise = loader.reload().then(() => loader);
    if (!dynamicProject) loaderCache.set(cacheKey, loaderPromise);
  }
  return loaderPromise;
}

function sessionDirFor(agent) {
  return join(process.cwd(), "runtime", "sessions", agent.key);
}

export function buildPrompt(text, context) {
  const artifactsDir = context.artifactsDir
    || (context.projectName ? artifactsDirFor(context.taskId, context.projectName) : null);
  if (context.statusQuery) {
    return [
      `要查询的根任务编号：${context.taskId}`,
      `当前群聊：${context.chatId || ""}`,
      `用户请求：${text || "查询当前任务状态"}`,
      "",
      "这是只读状态查询。必须调用 get_task_status，并将上面的根任务编号作为 taskId 传入。",
      "不要调用 deliver_artifact，不要创建或修改任务，不要派发下游；根据工具返回的结构化状态用简洁中文回答。",
    ].join("\n");
  }
  const artifactInstruction = artifactsDir
    ? `产物目录：${artifactsDir}`
    : "项目尚未确定：先调用 create_project 创建或切换项目，再将交付物写入该项目的 artifacts 目录。";
  return [
    `任务编号：${context.taskId}`,
    artifactInstruction,
    `用户指令：${text || "（未提供）"}`,
    ``,
    `请处理该任务。若需产出交付物，请写入产物目录，并用 deliver_artifact 工具交付。`,
    `不要输出思考过程、工具调用过程或英文工作日志，不要复述本提示词；只输出最终中文结果。`,
  ].join("\n");
}

export function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

// 模型偶尔会把英文的内部工作日志作为普通文本吐出。这里只过滤明确的
// “我现在要……/让我……”式过程句，不翻译或删除正常的技术术语和结果描述。
const INTERNAL_WORK_LOG = /^(?:[-*]\s*)?(?:i['’]ll|i will|now let me|let me|first[,：:]?\s+i|next[,：:]?\s+i|i need to|i should|i['’]m going to|i am going to|interesting[,：:]?|let['’]s)\b[\s\S]*$/i;

export function sanitizeAgentReply(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_WORK_LOG.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function testCommand(command = "") {
  return /(?:^|[\s;&|])(?:npm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|pnpm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|yarn\s+(?:run\s+)?(?:test|vitest|jest|playwright)|bun\s+(?:run\s+)?(?:test|vitest|jest|playwright)|pytest|vitest|jest|playwright\s+test)(?:\s|$)/i.test(command);
}

export function mapPiToolEvent(event = {}, context = {}, previous = {}) {
  const common = {
    task_id: context.taskId || null,
    parent_task_id: context.parentTaskId || null,
    agent: context.agentKey || null,
  };
  if (event.type === "agent_start") return [{ ...common, type: "agent_started", status: "running", summary: "Agent 开始执行" }];
  if (event.type === "agent_settled") {
    return [{ ...common, type: "agent_finished", status: "completed", summary: "Agent 执行轮次结束" }];
  }
  if (event.type === "tool_execution_start") {
    const args = event.args || {};
    const command = ["bash", "powershell"].includes(event.toolName) ? String(args.command || "") : "";
    const filePath = ["write", "edit"].includes(event.toolName) ? String(args.path || "") : "";
    const events = [{ ...common, type: "tool_call", status: "running", tool: event.toolName, ...(command ? { command } : {}), ...(filePath ? { file_path: filePath } : {}), summary: "工具开始执行" }];
    if (command && testCommand(command)) events.push({ ...common, type: "test_started", status: "running", tool: event.toolName, command, summary: "测试开始" });
    return events;
  }
  if (event.type === "tool_execution_end") {
    const failed = event.isError === true;
    const command = String(previous.command || "");
    const events = [{ ...common, type: "tool_result", status: failed ? "failed" : "completed", tool: event.toolName, summary: failed ? "工具执行失败" : "工具执行完成" }];
    if (["write", "edit"].includes(event.toolName) && !failed && previous.path) {
      events.push({ ...common, type: "file_change", status: "completed", tool: event.toolName, file_path: String(previous.path), summary: event.toolName === "write" ? "文件已创建或覆盖" : "文件已编辑" });
    }
    if (command && testCommand(command)) events.push({ ...common, type: "test_result", status: failed ? "failed" : "passed", tool: event.toolName, command, summary: failed ? "测试命令失败" : "测试命令完成" });
    if (failed) events.push({ ...common, type: "error", status: "failed", tool: event.toolName, summary: "工具调用失败", error: "工具返回错误" });
    return events;
  }
  return [];
}

export function createDeliverTool({ getArtifactsDir, getProjectName, agentKey, agentName, onDeliver }) {
  return defineTool({
    name: "deliver_artifact",
    label: "交付产物",
    description: "完成任务后交付：提交摘要、产物路径、假设和下一步建议。交付后任务才算完成。",
    parameters: Type.Object({
      summary: Type.String({ description: "交付摘要（必填，需包含：结论 + 关键决策 + 产物内容要点，让人不看文件也能判断成果）" }),
      artifactPaths: Type.Optional(Type.Array(Type.String(), { description: "产物文件路径列表" })),
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
        agentKey: Type.String(),
        task: Type.String(),
        reason: Type.Optional(Type.String()),
      }))),
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
      const delivery = {
        summary: sanitizeAgentReply(params.summary),
        artifactPaths: params.artifactPaths || [],
        next: params.next || "",
        blockers: params.blockers || [],
        assumptions: params.assumptions || [],
        risks: params.risks || [],
        choices: params.choices || [],
        assignments: normalizeAssignments(params.assignments),
        diagram: params.diagram || null,
        final: params.final === true,
        artifactsDir,
        projectName: getProjectName?.() || null,
        agentKey,
        agentName,
      };
      await saveDelivery(artifactsDir, agentKey, delivery);
      await onDeliver?.(delivery);
      return {
        content: [{ type: "text", text: `已交付：${sanitizeAgentReply(params.summary)}` }],
        details: {},
      };
    },
  });
}

function normalizeAssignments(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(agentsConfig.agents.map((agent) => agent.key));
  const seen = new Set();
  return value
    .filter((item) => item && allowed.has(item.agentKey) && typeof item.task === "string" && item.task.trim())
    .map((item) => ({
      agentKey: item.agentKey,
      task: item.task.trim(),
      reason: typeof item.reason === "string" ? item.reason.trim() : "",
    }))
    .filter((item) => !seen.has(item.agentKey) && seen.add(item.agentKey));
}

export function createProjectTool({ onProject, root = process.cwd() }) {
  return defineTool({
    name: "create_project",
    label: "创建项目",
    description: "确认英文项目名后调用：创建或切换到 workspace/<项目名>/ 项目目录。",
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
      return { content: [{ type: "text", text: `项目 ${name} 已就绪（workspace/${name}/）。` }], details: {} };
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

export function createAgentCliTool({ taskId, projectName, getProjectName, chatId, agentKey, root = process.cwd(), execute = executeAgentCli }) {
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
      const result = await execute(action, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

export async function runAgent(agent, text, context, { sessionFile } = {}) {
  if (await isTerminated(context.taskId)) return { text: "", cancelled: true, sessionFile: sessionFile || null, delivery: null, projectName: context.projectName || null };
  const modelRuntime = await getModelRuntime();
  const model = modelRuntime.getModel(MODEL_PROVIDER, MODEL_ID);
  if (!model) {
    const credentialHint = MODEL_PROVIDER === "deepseek"
      ? "请配置 DEEPSEEK_API_KEY，或先用 pi login deepseek 完成认证"
      : `请配置 ${MODEL_PROVIDER} 的 API Key 或 pi 登录凭据`;
    throw new Error(`模型不可用: ${MODEL_PROVIDER}/${MODEL_ID}。${credentialHint}`);
  }

  let activeProject = context.projectName || null;
  const loader = await getLoader(agent, () => activeProject);
  const cfg = policy.agents?.[agent.key] ?? {};
  const sessionDir = sessionDirFor(agent);
  await mkdir(sessionDir, { recursive: true });
  // session 文件可能因清理/迁移而丢失：存在才复用，否则新建，避免写入时 ENOENT。
  let sessionManager;
  if (sessionFile && existsSync(sessionFile)) {
    sessionManager = SessionManager.open(sessionFile, sessionDir);
  } else {
    if (sessionFile) {
      console.warn(`[pi-agent] session 文件不存在，已新建会话: ${sessionFile}`);
    }
    sessionManager = SessionManager.create(process.cwd(), sessionDir);
  }

  const getArtifactsDir = () => context.artifactsDir || artifactsDirFor(context.taskId, activeProject);
  let delivery = null;
  const deliverTool = createDeliverTool({
    getArtifactsDir,
    getProjectName: () => activeProject,
    agentKey: agent.key,
    agentName: agent.displayName,
    onDeliver: (d) => { delivery = d; },
  });

  const tools = [...(cfg.tools || DEFAULT_TOOLS)];
  const customTools = [];
  if (!context.statusQuery) {
    tools.push("deliver_artifact");
    customTools.push(deliverTool);
    tools.push("agent_cli");
    customTools.push(createAgentCliTool({ taskId: context.taskId, getProjectName: () => activeProject, agentKey: agent.key, chatId: context.chatId }));
  }
  if (context.statusQuery) {
    customTools.push(createTaskStatusTool({ taskId: context.taskId, chatId: context.chatId }));
    tools.push("get_task_status");
  }
  if (agent.key === "project_manager") {
    customTools.push(createProjectTool({ onProject: (name) => { activeProject = name; } }));
    tools.push("create_project");
    if (!context.statusQuery) {
      customTools.push(createTaskStatusTool({ taskId: context.taskId, chatId: context.chatId }));
      tools.push("get_task_status");
    }
  }

  const { session } = await createAgentSession({
    model,
    thinkingLevel: cfg.thinking || THINKING_LEVEL,
    modelRuntime,
    tools,
    customTools,
    sessionManager,
    resourceLoader: loader,
  });
  const unregisterSession = registerActiveSession(context.taskId, session);

  let reply = "";
  let traceChain = Promise.resolve();
  const emitTrace = (events) => {
    for (const event of events) {
      traceChain = traceChain
        .then(() => context.onEvent?.(event))
        .catch((error) => console.warn(`[pi-agent] trace event dropped: ${error.message}`));
    }
  };
  const toolInputs = new Map();
  try {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        reply += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") toolInputs.set(event.toolCallId, event.args || {});
      emitTrace(mapPiToolEvent(event, context, toolInputs.get(event.toolCallId) || {}));
      if (event.type === "tool_execution_end") toolInputs.delete(event.toolCallId);
    });

    if (await isTerminated(context.taskId)) return { text: "", cancelled: true, sessionFile: session.sessionFile || sessionFile || null, delivery: null, projectName: activeProject };
    await session.prompt(buildPrompt(text, context));
    await traceChain;
    if (await isTerminated(context.taskId)) return { text: "", cancelled: true, sessionFile: session.sessionFile || sessionFile || null, delivery: null, projectName: activeProject };

    if (!reply.trim()) {
      const last = [...session.messages].reverse().find((m) => m.role === "assistant");
      reply = extractText(last);
    }
    return {
      text: sanitizeAgentReply(reply) || "（Agent 未返回文本结果）",
      sessionFile: session.sessionFile || sessionFile || null,
      delivery,
      projectName: activeProject || null,
    };
  } catch (error) {
    if (await isTerminated(context.taskId)) {
      await traceChain;
      return { text: "", cancelled: true, sessionFile: session.sessionFile || sessionFile || null, delivery: null, projectName: activeProject };
    }
    emitTrace([{ task_id: context.taskId, parent_task_id: context.parentTaskId || null, agent: agent.key, type: "error", status: "failed", error: error.message, summary: "Agent 执行失败" }]);
    await traceChain;
    throw error;
  } finally {
    unregisterSession();
    session.dispose();
  }
}
