import test from "node:test";
import assert from "node:assert/strict";
import { RPC_CONTEXT_ENV } from "../src/runtime/pi-extension.mjs";
import { createAgentRunner, rpcArgsFor } from "../src/runtime/agent-runner.js";

test("rpcArgsFor loads the policy extension and blocks delivery during status queries", () => {
  const extensionPath = "D:/repo/src/runtime/pi-extension.mjs";
  const normal = rpcArgsFor({
    agent: { key: "tester" },
    context: { statusQuery: false },
    systemPrompt: "SYS",
    extensionPath,
  });
  assert.deepEqual(normal.slice(0, 3), ["-e", extensionPath, "--no-extensions"]);
  assert.ok(normal.includes("--no-context-files"));
  assert.ok(normal.includes("--system-prompt"));
  const normalTools = normal[normal.indexOf("--tools") + 1];
  assert.match(normalTools, /deliver_artifact/);
  assert.match(normalTools, /agent_cli/);
  assert.match(normalTools, /get_task_status/);

  const status = rpcArgsFor({
    agent: { key: "tester" },
    context: { statusQuery: true },
    systemPrompt: "SYS",
    extensionPath,
  });
  const statusTools = status[status.indexOf("--tools") + 1];
  assert.doesNotMatch(statusTools, /deliver_artifact/);
  assert.doesNotMatch(statusTools, /agent_cli/);
  assert.match(statusTools, /get_task_status/);
});

test("RPC runner keeps the repository root cwd and passes the serialized task context", async () => {
  const calls = [];
  const runner = {
    run: async (prompt, options) => {
      calls.push({ prompt, options });
      return { text: "完成", events: [], exit: { code: 0, signal: null } };
    },
  };
  const runAgentRpc = createAgentRunner({ runner, root: "D:/repo" });
  await runAgentRpc(
    { key: "tester", displayName: "测试", max_runtime_seconds: 5 },
    "执行测试",
    { projectName: "student", taskId: "T-rpc", systemPrompt: "SYS", context: { chatId: "chat-1" } },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, "D:/repo");
  assert.ok(calls[0].options.args.includes("--system-prompt"));
  const context = JSON.parse(calls[0].options.env[RPC_CONTEXT_ENV]);
  assert.equal(context.root, "D:/repo");
  assert.equal(context.taskId, "T-rpc");
  assert.equal(context.agentKey, "tester");
  assert.equal(context.agentName, "测试");
  assert.equal(context.projectName, "student");
  assert.equal(context.chatId, "chat-1");
});

test("worktree isolation stays opt-in and only switches cwd when explicitly enabled", async () => {
  const calls = [];
  const runner = { run: async (_prompt, options) => { calls.push(options); return { text: "", events: [], exit: { code: 0 } }; } };
  const worktrees = [];
  const worktreeFactory = async ({ root, agentKey, taskId }) => {
    const target = `${root}/runtime/workspaces/${agentKey}/${taskId}`;
    worktrees.push(target);
    return target;
  };

  const collected = [];
  const collectWorktreeChanges = async (input) => {
    collected.push(input);
    return { files: [{ status: "M", path: "src/a.js" }], patchPath: "runtime/workspaces/frontend_developer/T-iso/worktree-changes.patch" };
  };
  const isolated = createAgentRunner({
    runner,
    root: "D:/repo",
    useWorktree: true,
    createWorktree: worktreeFactory,
    collectWorktreeChanges,
  });
  const result = await isolated({ key: "frontend_developer" }, "改页面", { taskId: "T-iso" });
  assert.deepEqual(worktrees, ["D:/repo/runtime/workspaces/frontend_developer/T-iso"]);
  assert.equal(calls[0].cwd, "D:/repo/runtime/workspaces/frontend_developer/T-iso");
  assert.equal(collected.length, 1);
  assert.equal(collected[0].agentKey, "frontend_developer");
  assert.match(collected[0].artifactsDir, /workspace[\\/]default[\\/]artifacts[\\/]T-iso$/);
  assert.deepEqual(result.worktree, {
    files: [{ status: "M", path: "src/a.js" }],
    patchPath: "runtime/workspaces/frontend_developer/T-iso/worktree-changes.patch",
  });

  calls.length = 0;
  const shared = createAgentRunner({ runner, root: "D:/repo", useWorktree: false, createWorktree: worktreeFactory });
  await shared({ key: "frontend_developer" }, "改页面", { taskId: "T-shared" });
  assert.equal(calls[0].cwd, "D:/repo");
  assert.equal(worktrees.length, 1);
});
