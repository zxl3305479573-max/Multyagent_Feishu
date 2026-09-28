// 真实 MultyAgent 执行逻辑的集成边界：默认使用内置 Pi，会话也可切换到 RPC 子进程。
import { runAgent as runEmbeddedAgent } from "./pi-agent.js";
import { createAgentRunner } from "./runtime/agent-runner.js";

function rpcTraceEvent(event, { taskId, agentKey }) {
  if (!event || typeof event !== "object") return null;
  const allowed = {
    task_id: taskId || null,
    agent: agentKey || null,
    type: "rpc_event",
    rpc_type: String(event.type || "unknown"),
    ...(event.toolName ? { tool: String(event.toolName) } : {}),
    ...(event.type === "agent_settled" ? { status: "completed" } : {}),
    ...(event.type === "error" ? { status: "failed" } : {}),
    ...(event.type === "tool_execution_start" ? { status: "running" } : {}),
    ...(event.type === "tool_execution_end" ? { status: event.isError === true ? "failed" : "completed" } : {}),
  };
  return allowed;
}

export function createRunAgent({ mode = process.env.PI_AGENT_RUNTIME || "embedded", embedded = runEmbeddedAgent, rpcRun = createAgentRunner() } = {}) {
  return async function runAgent(agent, prompt, context = {}, options = {}) {
    if (mode !== "rpc") return embedded(agent, prompt, context, options);
    const result = await rpcRun(agent, prompt, {
      projectName: context.projectName || "default",
      taskId: context.taskId,
      timeoutMs: options.timeoutMs || (Number(agent.max_runtime_seconds) > 0 ? Number(agent.max_runtime_seconds) * 1000 : undefined),
      env: options.env,
      onEvent: (event) => {
        const safe = rpcTraceEvent(event, { taskId: context.taskId, agentKey: agent.key });
        if (safe) return context.onEvent?.(safe);
      },
    });
    return {
      text: String(result?.text || "").trim(),
      delivery: null,
      projectName: context.projectName || null,
      rpc: { exit: result?.exit || null },
    };
  };
}

export const runAgent = createRunAgent();

export { rpcTraceEvent };
