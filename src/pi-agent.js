// Pi Agent 运行时桥接层（最小纵向切片）。
// 职责：把飞书任务交给一个真实 Pi 会话处理，返回文本结果。
//
// 当前范围（步骤 3 + 阶段一）：
//   - 每次任务新建一个 in-memory session，prompt 后 dispose（天然并发隔离）。
//   - 角色身份 + 职责通过 systemPromptOverride 注入系统提示（强约束，防身份幻觉）。
//   - 工具白名单、职责、思考等级从 config/roles/<role>.json 按角色读取（经 src/role-config.cjs 校验）。
//   - 策略扩展拦截敏感文件（复用 spike/pi-policy.mjs 已验证的结论）。
//
// 后续阶段（暂未实现，见设计文档实施阶段）：
//   - 会话持久化 + task_id 复用（多轮追问）
//   - 路径级拦截 + 正式策略扩展，然后放开可写工具（edit/write）
//   - RPC 子进程隔离
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { artifactsDirFor } from "./artifacts.js";
import { isTerminated } from "./tasks.js";
import { registerActiveSession } from "./session-control.js";
import { roleConfig } from "./role-config.cjs";
import { createPolicyFactory } from "./agent/policy-gate.js";
import { getCapabilityRegistry } from "./capabilities/index.js";
import { buildPrompt, buildSystemPrompt, DEFAULT_TOOLS, extractText, sanitizeAgentReply } from "./agent/prompts.js";
import { mapPiToolEvent } from "./agent/tool-events.js";
import { buildTaskPlanRoleLimits, createAgentCliTool, createDeliverTool, createProjectTool, createTaskStatusTool } from "./agent/tools.js";

// 对外接口保持不变：策略闸门、提示构造、事件映射和受控工具已拆到 src/agent/ 下，这里统一转出。
export { createPolicyFactory, SENSITIVE_PATTERNS } from "./agent/policy-gate.js";
export { buildPrompt, buildSystemPrompt, extractText, sanitizeAgentReply } from "./agent/prompts.js";
export { mapPiToolEvent } from "./agent/tool-events.js";
export { createAgentCliTool, createDeliverTool, createProjectTool, createTaskStatusTool, normalizeAssignments } from "./agent/tools.js";

const MODEL_PROVIDER = process.env.PI_AGENT_PROVIDER || "deepseek";
// deepseek-flash is the default runtime model; override with PI_AGENT_MODEL when needed.
const MODEL_ID = process.env.PI_AGENT_MODEL || "deepseek-flash";
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
  const candidates = [
    configured,
    join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "diagram-design"),
    join(homedir(), ".codex", "skills", "diagram-design"),
  ].filter(Boolean);
  const skillPath = candidates.find((candidate) => existsSync(candidate));
  return skillPath ? [skillPath] : [];
}

// Backward-compatible name for callers that used the original architect-only
// helper before project-manager support was added.
export const architectSkillPaths = diagramSkillPaths;

// 角色策略统一来自 config/roles/*.json（加载时校验，配置有误直接报错）。
const { policy } = roleConfig();

let modelRuntimePromise;

function getModelRuntime() {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create();
  }
  return modelRuntimePromise;
}

// 每个角色缓存一份 loader（系统提示不同），首次创建后复用。
const loaderCache = new Map();

function getLoader(agent, projectNameOrGetter, taskPermissionsGetter = null) {
  const dynamicProject = typeof projectNameOrGetter === "function";
  const getProjectName = dynamicProject ? projectNameOrGetter : () => projectNameOrGetter;
  const projectName = getProjectName();
  // 用户给该角色添加的 Skill / 插件；能力库每次变更版本号都会变，缓存随之失效，无需重启网关。
  const capabilities = getCapabilityRegistry().forRole(agent.key);
  const cacheKey = `${agent.key}:${projectName || "default"}:${capabilities.version}`;
  let loaderPromise = loaderCache.get(cacheKey);
  if (!loaderPromise || dynamicProject) {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      additionalSkillPaths: [...diagramSkillPaths(agent.key), ...capabilities.skillPaths],
      additionalExtensionPaths: capabilities.extensionPaths,
      systemPromptOverride: () => buildSystemPrompt(agent, getProjectName()),
      extensionFactories: [createPolicyFactory(agent, getProjectName, taskPermissionsGetter)],
    });
    loaderPromise = loader.reload().then(() => loader);
    if (!dynamicProject) loaderCache.set(cacheKey, loaderPromise);
  }
  return loaderPromise;
}

export function sessionDirFor(agent, projectName) {
  const project = /^[a-z][a-z0-9-]*$/.test(String(projectName || "")) ? projectName : "unassigned";
  return join(process.cwd(), "runtime", "sessions", project, agent.key);
}

export function sessionFileBelongsToDir(sessionFile, sessionDir) {
  if (!sessionFile || !sessionDir) return false;
  const candidate = isAbsolute(sessionFile) ? sessionFile : resolve(sessionFile);
  const relativePath = relative(resolve(sessionDir), candidate);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
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
  const loader = await getLoader(agent, () => activeProject, () => context.taskPermissions);
  const cfg = policy.agents?.[agent.key] ?? {};
  const sessionDir = sessionDirFor(agent, context.projectName);
  await mkdir(sessionDir, { recursive: true });
  // session 文件可能因清理/迁移而丢失：存在才复用，否则新建，避免写入时 ENOENT。
  let sessionManager;
  const candidateSessionFile = sessionFile ? (isAbsolute(sessionFile) ? sessionFile : resolve(sessionFile)) : null;
  const sessionBelongsToProject = sessionFileBelongsToDir(candidateSessionFile, sessionDir);
  if (sessionBelongsToProject && existsSync(candidateSessionFile)) {
    sessionManager = SessionManager.open(candidateSessionFile, sessionDir);
  } else {
    if (sessionFile && !sessionBelongsToProject) {
      console.warn(`[pi-agent] session 不属于当前项目/Agent，已隔离新建会话: ${sessionFile}`);
    } else if (sessionFile) {
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
    roleLimits: () => buildTaskPlanRoleLimits(activeProject),
    onDeliver: (d) => { delivery = d; },
  });

  const tools = [...(cfg.tools || DEFAULT_TOOLS)];
  const customTools = [];
  if (!context.statusQuery) {
    // 插件声明的工具要显式加入可用工具列表，否则即使扩展注册了也不会启用。
    for (const tool of getCapabilityRegistry().forRole(agent.key).tools) if (!tools.includes(tool)) tools.push(tool);
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
