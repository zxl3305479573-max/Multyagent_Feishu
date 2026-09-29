import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRpcExtension,
  readRpcDelivery,
  rpcArtifactsDir,
  rpcContextFromEnv,
  rpcDeliveryFile,
  rpcToolPlan,
} from "../src/runtime/pi-extension.mjs";

test("rpcContextFromEnv parses the serialized runtime context", () => {
  assert.equal(rpcContextFromEnv({}), null);
  const context = rpcContextFromEnv({ PI_AGENT_CONTEXT: JSON.stringify({ taskId: "T-1", agentKey: "tester" }) });
  assert.deepEqual(context, { taskId: "T-1", agentKey: "tester" });
  assert.throws(() => rpcContextFromEnv({ PI_AGENT_CONTEXT: "{" }), /valid JSON/);
});

test("rpcDeliveryFile keeps task and agent inside runtime/rpc-deliveries", () => {
  const file = rpcDeliveryFile({ root: "D:/repo", taskId: "T-1", agentKey: "tester" });
  assert.match(file, /runtime[\\/]rpc-deliveries[\\/]T-1[\\/]tester\.json$/);
  assert.throws(() => rpcDeliveryFile({ root: "D:/repo", taskId: "../escape", agentKey: "tester" }), /Invalid task id/);
  assert.throws(() => rpcDeliveryFile({ root: "D:/repo", taskId: "T-1", agentKey: "../escape" }), /Invalid agent key/);
});

test("rpcToolPlan mirrors the embedded-mode tool grants", () => {
  const normal = rpcToolPlan("tester", { statusQuery: false });
  assert.ok(normal.includes("deliver_artifact"));
  assert.ok(normal.includes("agent_cli"));
  assert.ok(normal.includes("get_task_status"));
  assert.ok(normal.includes("read"));

  const status = rpcToolPlan("tester", { statusQuery: true });
  assert.equal(status.includes("deliver_artifact"), false);
  assert.equal(status.includes("agent_cli"), false);
  assert.ok(status.includes("get_task_status"));

  assert.ok(rpcToolPlan("project_manager", { statusQuery: false }).includes("create_project"));
});

test("rpcArtifactsDir resolves project and explicit artifact directories against the repository root", () => {
  assert.equal(
    rpcArtifactsDir({ root: "D:/repo", taskId: "T-1", projectName: "student" }),
    resolve("D:/repo", "workspace", "student", "artifacts", "T-1"),
  );
  assert.equal(
    rpcArtifactsDir({ root: "D:/repo", taskId: "T-1", projectName: "student", artifactsDir: "runtime/artifacts/T-1" }),
    resolve("D:/repo", "runtime", "artifacts", "T-1"),
  );
});

test("createRpcExtension registers the same policy gate and controlled tools as embedded mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extension-"));
  const registered = [];
  const calls = {};
  const api = {
    registerTool: (tool) => registered.push(tool.name),
    on: () => {},
  };
  const tools = {
    createPolicyFactory: (agent, getProjectName) => {
      calls.policy = { agent, getProjectName };
      return (target) => { calls.gateTarget = target; };
    },
    createDeliverTool: (options) => { calls.deliver = options; return { name: "deliver_artifact" }; },
    createAgentCliTool: (options) => { calls.cli = options; return { name: "agent_cli" }; },
    createTaskStatusTool: (options) => { calls.status = options; return { name: "get_task_status" }; },
    createProjectTool: (options) => { calls.project = options; return { name: "create_project" }; },
  };
  try {
    createRpcExtension(api, {
      root,
      context: { agentKey: "project_manager", agentName: "项目经理", taskId: "T-1", chatId: "chat-1", projectName: "student" },
      tools,
    });

    assert.deepEqual(registered, ["deliver_artifact", "agent_cli", "get_task_status", "create_project"]);
    assert.equal(calls.gateTarget, api);
    assert.equal(calls.policy.agent.key, "project_manager");
    assert.equal(calls.policy.getProjectName(), "student");
    assert.equal(calls.deliver.getProjectName(), "student");
    assert.equal(calls.cli.agentKey, "project_manager");
    assert.equal(calls.status.chatId, "chat-1");

    await calls.deliver.onDeliver({ summary: "已完成", projectName: "student" });
    const saved = await readRpcDelivery({ root, taskId: "T-1", agentKey: "project_manager" });
    assert.equal(saved.summary, "已完成");

    calls.project.onProject("phone-login");
    assert.equal(calls.deliver.getProjectName(), "phone-login");
    assert.equal(
      calls.deliver.getArtifactsDir(),
      resolve(root, "workspace", "phone-login", "artifacts", "T-1"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("statusQuery RPC sessions do not register delivery or controlled CLI tools", () => {
  const registered = [];
  const api = { registerTool: (tool) => registered.push(tool.name), on: () => {} };
  const tools = {
    createPolicyFactory: () => () => {},
    createDeliverTool: () => { throw new Error("must not register deliver_artifact"); },
    createAgentCliTool: () => { throw new Error("must not register agent_cli"); },
    createTaskStatusTool: () => ({ name: "get_task_status" }),
    createProjectTool: () => ({ name: "create_project" }),
  };
  createRpcExtension(api, {
    context: { agentKey: "tester", taskId: "T-status", chatId: "chat-2", statusQuery: true },
    tools,
  });
  assert.deepEqual(registered, ["get_task_status"]);
});
