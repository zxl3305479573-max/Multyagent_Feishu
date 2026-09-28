import test from "node:test";
import assert from "node:assert/strict";
import { createRunAgent } from "../src/handlers.js";

test("RPC 运行模式把任务上下文和安全事件回传到网关", async () => {
  const calls = [];
  const events = [];
  const runRpc = async (agent, prompt, options) => {
    calls.push({ agent, prompt, options });
    options.onEvent?.({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    return { text: "RPC 完成", events: [], exit: { code: 0, signal: null } };
  };
  const runAgent = createRunAgent({ mode: "rpc", rpcRun: runRpc });

  const result = await runAgent(
    { key: "tester", displayName: "测试", max_runtime_seconds: 12 },
    "执行回归测试",
    { taskId: "T-rpc", projectName: "student", onEvent: (event) => events.push(event) },
  );

  assert.equal(result.text, "RPC 完成");
  assert.equal(result.projectName, "student");
  assert.equal(calls[0].prompt, "执行回归测试");
  assert.equal(calls[0].options.projectName, "student");
  assert.equal(calls[0].options.taskId, "T-rpc");
  assert.equal(calls[0].options.timeoutMs, 12_000);
  assert.deepEqual(events, [{ task_id: "T-rpc", agent: "tester", type: "rpc_event", rpc_type: "tool_execution_start", tool: "bash", status: "running" }]);
});

test("默认运行模式使用内置 Agent，不创建 RPC 进程", async () => {
  let embeddedCalls = 0;
  const embedded = async (_agent, prompt, context) => {
    embeddedCalls += 1;
    return { text: `${prompt}:${context.taskId}` };
  };
  const runAgent = createRunAgent({ mode: "embedded", embedded });
  const result = await runAgent({ key: "tester" }, "检查", { taskId: "T-embedded" });
  assert.equal(result.text, "检查:T-embedded");
  assert.equal(embeddedCalls, 1);
});
