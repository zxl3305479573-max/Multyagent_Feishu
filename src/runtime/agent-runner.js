import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultPiRpcRunner } from "./pi-rpc-runner.js";
import { createWorktree } from "./worktree.js";

export function createAgentRunner({ runner = defaultPiRpcRunner(), root = process.cwd(), useWorktree = false } = {}) {
  return async function runAgentRpc(agent, prompt, { projectName = "default", taskId, timeoutMs, env, onEvent } = {}) {
    const workspace = (agent.workspace || "workspace/{project}").replace("{project}", projectName);
    const cwd = useWorktree && taskId
      ? await createWorktree({ root, agentKey: agent.key, taskId })
      : resolve(root, workspace);
    const sessionDir = resolve(root, agent.session_dir || `runtime/sessions/${agent.key}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    return runner.run(prompt, {
      cwd,
      sessionDir,
      timeoutMs: timeoutMs || agent.max_runtime_seconds * 1000,
      env,
      onEvent,
    });
  };
}
