// Pi RPC 扩展：把内置模式使用的策略闸门和受控工具搬到 RPC 子进程，
// 让 PI_AGENT_RUNTIME=embedded 与 rpc 拥有同一套权限边界。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { artifactsDirFor } from "../artifacts.js";

const require = createRequire(import.meta.url);
const policy = require("../../config/policy.json");

export const RPC_CONTEXT_ENV = "PI_AGENT_CONTEXT";
const DEFAULT_TOOLS = ["read", "ls", "grep", "find"];

function safeSegment(value, label) {
  const part = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(part) || part === "." || part === "..") {
    throw new Error(`Invalid ${label}`);
  }
  return part;
}

export function rpcContextFromEnv(env = process.env) {
  const raw = env?.[RPC_CONTEXT_ENV];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${RPC_CONTEXT_ENV} must be valid JSON`);
  }
}

export function rpcDeliveryFile({ root = process.cwd(), taskId, agentKey } = {}) {
  const task = safeSegment(taskId, "task id");
  const agent = safeSegment(agentKey, "agent key");
  return join(resolve(root), "runtime", "rpc-deliveries", task, `${agent}.json`);
}

export async function readRpcDelivery({ root = process.cwd(), taskId, agentKey } = {}) {
  if (!taskId || !agentKey) return null;
  try {
    const text = await readFile(rpcDeliveryFile({ root, taskId, agentKey }), "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// 与内置模式的工具注册顺序保持一致：状态查询只给只读状态工具，
// 正常任务才给交付、受控 CLI 和项目经理建项目工具。
export function rpcToolPlan(agentKey, { statusQuery = false } = {}) {
  const cfg = policy.agents?.[agentKey] ?? {};
  const tools = [...(cfg.tools || DEFAULT_TOOLS), "get_task_status"];
  if (!statusQuery) tools.push("deliver_artifact", "agent_cli");
  if (agentKey === "project_manager") tools.push("create_project");
  return [...new Set(tools)];
}

export function rpcArtifactsDir({ root = process.cwd(), taskId, projectName, artifactsDir } = {}) {
  return artifactsDir ? resolve(root, artifactsDir) : resolve(root, artifactsDirFor(taskId, projectName));
}

export function createRpcExtension(api, { context, tools, root = process.cwd() } = {}) {
  if (!context) throw new Error("RPC context is required");
  if (!tools) throw new Error("RPC tool factories are required");
  let activeProject = context.projectName || null;
  const getProjectName = () => activeProject;
  const agent = { key: context.agentKey, displayName: context.agentName || context.agentKey };
  const getArtifactsDir = () => rpcArtifactsDir({
    root,
    taskId: context.taskId,
    projectName: activeProject,
    artifactsDir: context.artifactsDir,
  });

  tools.createPolicyFactory(agent, getProjectName)(api);

  if (!context.statusQuery) {
    api.registerTool(tools.createDeliverTool({
      getArtifactsDir,
      getProjectName,
      agentKey: context.agentKey,
      agentName: agent.displayName,
      onDeliver: async (delivery) => {
        const file = rpcDeliveryFile({ root, taskId: context.taskId, agentKey: context.agentKey });
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(delivery, null, 2));
      },
    }));
    api.registerTool(tools.createAgentCliTool({
      taskId: context.taskId,
      getProjectName,
      chatId: context.chatId,
      agentKey: context.agentKey,
      root,
    }));
  }

  api.registerTool(tools.createTaskStatusTool({ taskId: context.taskId, chatId: context.chatId }));
  if (context.agentKey === "project_manager") {
    api.registerTool(tools.createProjectTool({ root, onProject: (name) => { activeProject = name; } }));
  }
}

export default async function rpcExtension(api) {
  const context = rpcContextFromEnv();
  if (!context) throw new Error(`${RPC_CONTEXT_ENV} is required for the RPC extension`);
  const tools = await import("../pi-agent.js");
  createRpcExtension(api, { context, tools });
}
