import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagramSkillPaths } from "../pi-agent.js";
import { getCapabilityRegistry } from "../capabilities/index.js";
import { defaultPiRpcRunner } from "./pi-rpc-runner.js";
import { RPC_CONTEXT_ENV, readRpcDelivery, rpcArtifactsDir, rpcDeliveryFile, rpcToolPlan } from "./pi-extension.mjs";
import { collectWorktreeChanges, createWorktree } from "./worktree.js";

// RPC 子进程与内置模式保持同样的 cwd（仓库根目录），否则产物目录、
// 任务状态文件和受控 CLI 的相对路径会落到项目工作区里。
export function rpcArgsFor({ agent, context, systemPrompt, extensionPath, capabilities = getCapabilityRegistry().forRole(agent.key) }) {
  const statusQuery = context.statusQuery === true;
  const tools = rpcToolPlan(agent.key, { statusQuery });
  // 用户给该角色添加的插件工具（状态查询不需要执行类工具）。
  if (!statusQuery) for (const tool of capabilities.tools) if (!tools.includes(tool)) tools.push(tool);
  const args = [
    "-e", extensionPath,
    ...capabilities.extensionPaths.flatMap((path) => ["-e", path]),
    "--no-extensions",
    "--no-context-files",
    "--provider", process.env.PI_AGENT_PROVIDER || "deepseek",
    "--model", process.env.PI_AGENT_MODEL || "deepseek-chat",
    "--thinking", process.env.PI_AGENT_THINKING || "off",
    "--tools", tools.join(","),
  ];
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  for (const skill of [...diagramSkillPaths(agent.key), ...capabilities.skillPaths]) args.push("--skill", skill);
  return args;
}

export function createAgentRunner({
  runner = defaultPiRpcRunner(),
  root = process.cwd(),
  useWorktree = process.env.PI_AGENT_WORKTREE === "1",
  createWorktree: worktreeFactory = createWorktree,
  collectWorktreeChanges: collectChanges = collectWorktreeChanges,
} = {}) {
  const extensionPath = fileURLToPath(new URL("./pi-extension.mjs", import.meta.url));
  return async function runAgentRpc(agent, prompt, {
    projectName = "default",
    taskId,
    timeoutMs,
    env,
    onEvent,
    systemPrompt,
    context: agentContext,
  } = {}) {
    const cwd = useWorktree && taskId
      ? await worktreeFactory({ root, agentKey: agent.key, taskId })
      : root;
    const sessionDir = resolve(root, agent.session_dir || `runtime/sessions/${agent.key}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const rpcContext = {
      ...(agentContext || {}),
      root,
      taskId,
      agentKey: agent.key,
      agentName: agent.displayName || agent.key,
      projectName: projectName || agentContext?.projectName || null,
      statusQuery: agentContext?.statusQuery === true,
    };
    if (taskId && agent.key) await rm(rpcDeliveryFile({ root, taskId, agentKey: agent.key }), { force: true });

    const result = await runner.run(prompt, {
      cwd,
      sessionDir,
      timeoutMs: timeoutMs || agent.max_runtime_seconds * 1000,
      env: { ...env, [RPC_CONTEXT_ENV]: JSON.stringify(rpcContext) },
      onEvent,
      args: rpcArgsFor({ agent, context: rpcContext, systemPrompt, extensionPath }),
    });
    const delivery = await readRpcDelivery({ root, taskId, agentKey: agent.key });
    let worktree = null;
    if (cwd !== root && taskId && agent.key) {
      try {
        const artifactsDir = rpcArtifactsDir({
          root,
          taskId,
          projectName: rpcContext.projectName,
          artifactsDir: rpcContext.artifactsDir,
        });
        worktree = await collectChanges({ root, agentKey: agent.key, taskId, artifactsDir });
      } catch (error) {
        worktree = { error: error.message };
      }
    }
    return { ...result, delivery, worktree, projectName: delivery?.projectName || rpcContext.projectName || null };
  };
}
