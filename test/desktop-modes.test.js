import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/domain/task-store.js";
import { createDesktopTaskSubmitter } from "../src/desktop-task.js";
import { ASK_TOOL_ALLOWLIST, applyModeToDelivery, normalizeModes } from "../src/desktop-modes.js";
import { createRunAgent } from "../src/handlers.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createDesktopHost } from "../src/desktop-host.js";

const PM = { key: "project_manager", displayName: "项目经理" };
const BACKEND = { key: "backend_developer", displayName: "后端开发" };
const quiet = { info() {}, warn() {}, error() {} };

test("modes are normalized with safe defaults", () => {
  assert.deepEqual(normalizeModes(), { mode: "auto", target: "team", runtime: null });
  assert.deepEqual(normalizeModes({ mode: "ask", target: "backend_developer", runtime: "rpc" }, { roleKeys: ["backend_developer"] }), { mode: "ask", target: "backend_developer", runtime: "rpc" });
  assert.deepEqual(normalizeModes({ mode: "yolo", target: "hacker", runtime: "docker" }, { roleKeys: ["backend_developer"] }), { mode: "auto", target: "team", runtime: null });
  assert.equal(normalizeModes({ target: "project_manager" }, { roleKeys: ["project_manager"] }).target, "team");
});

test("ask mode turns any delivery into a final answer without dispatch", () => {
  const delivery = applyModeToDelivery({ summary: "答", assignments: [{ agentKey: "tester", task: "x" }], plan: { stages: [] }, choices: [{ id: "a" }], next: "派给测试", final: false }, "ask");
  assert.deepEqual([delivery.assignments, delivery.plan, delivery.choices, delivery.next, delivery.final], [[], null, [], "", true]);
  const untouched = { summary: "x", final: false };
  assert.equal(applyModeToDelivery(untouched, "auto"), untouched);
});

test("the runtime can be chosen per call, falling back to the global setting", async () => {
  const calls = [];
  const runAgent = createRunAgent({
    mode: "embedded",
    embedded: async () => { calls.push("embedded"); return { text: "e" }; },
    rpcRun: async () => { calls.push("rpc"); return { text: "r" }; },
  });
  await runAgent(PM, "hi", { taskId: "T", runtime: "rpc" });
  await runAgent(PM, "hi", { taskId: "T" });
  await runAgent(PM, "hi", { taskId: "T", runtime: "bogus" });
  assert.deepEqual(calls, ["rpc", "embedded", "embedded"]);
});

async function submitterHarness(reply) {
  const root = await mkdtemp(join(tmpdir(), "desktop-modes-"));
  const store = new TaskStore(join(root, "tasks.json"));
  const runs = [];
  const completed = [];
  const submit = createDesktopTaskSubmitter({
    taskStore: store,
    orchestrator: { onTaskCompleted: async (agentKey, taskId, payload) => completed.push({ agentKey, taskId, payload }) },
    runAgent: async (agent, prompt, context) => {
      runs.push({ agent: agent.key, prompt, context });
      return { text: "ok", projectName: context.projectName, delivery: { agentKey: agent.key, summary: "完成", artifactPaths: [], ...reply } };
    },
    projectManagerAgent: PM,
    agents: [PM, BACKEND],
    loadProjectSummary: async () => null,
    idFactory: () => `m-${runs.length}-${Math.random()}`,
  });
  return { store, runs, completed, submit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("ask mode runs with read-only tools and never dispatches", async () => {
  const h = await submitterHarness({ assignments: [{ agentKey: "tester", task: "x" }], final: false });
  try {
    await h.submit({ projectName: "demo", description: "登录接口在哪个文件？", mode: "ask" });
    await h.submit.whenIdle();
    assert.match(h.runs[0].prompt, /【问答模式】/);
    assert.deepEqual(h.runs[0].context.taskPermissions, { toolAllowlist: ASK_TOOL_ALLOWLIST });
    assert.equal(ASK_TOOL_ALLOWLIST.includes("write") || ASK_TOOL_ALLOWLIST.includes("bash"), false);
    const { payload } = h.completed[0];
    assert.deepEqual(payload.delivery.assignments, []);
    assert.equal(payload.delivery.final, true);
    assert.equal(payload.context.requireHumanApproval, false);
  } finally { await h.cleanup(); }
});

test("a task can go straight to one bot on the chosen runtime, and the choice is stored on the task", async () => {
  const h = await submitterHarness({ final: false });
  try {
    const accepted = await h.submit({ projectName: "demo", description: "修复登录 500", target: "backend_developer", runtime: "rpc" });
    await h.submit.whenIdle();
    assert.equal(h.runs[0].agent, "backend_developer");
    assert.equal(h.runs[0].context.runtime, "rpc");
    assert.match(h.runs[0].prompt, /直接交给你（后端开发）/);
    assert.match(h.runs[0].prompt, /【单独处理】/);
    const { agentKey, payload } = h.completed[0];
    assert.equal(agentKey, "backend_developer");
    assert.equal(payload.context.singleRole, true);
    assert.equal(payload.context.runtime, "rpc");
    const task = await h.store.get(accepted.taskId);
    assert.equal(task.agent, "backend_developer");
    assert.equal(task.runtime, "rpc");
    assert.deepEqual(task.desktop_mode, { mode: "auto", target: "backend_developer" });
  } finally { await h.cleanup(); }
});

test("auto mode still waits for confirmation before a team plan is dispatched", async () => {
  const h = await submitterHarness({ assignments: [{ agentKey: "backend_developer", task: "实现注册接口" }], final: false });
  try {
    await h.submit({ projectName: "demo", description: "加个注册页", mode: "auto", target: "team" });
    await h.submit.whenIdle();
    const { agentKey, payload } = h.completed[0];
    assert.equal(agentKey, "project_manager");
    assert.equal(payload.context.requireHumanApproval, true);
    assert.equal(payload.approvalRequired, false, "the gate is triggered by the PM assignments");
    assert.deepEqual(payload.delivery.assignments.map((item) => item.agentKey), ["backend_developer"]);
  } finally { await h.cleanup(); }
});

test("plan mode asks for confirmation before the team or a single bot executes", async () => {
  const h = await submitterHarness({ final: false });
  try {
    await h.submit({ projectName: "demo", description: "加个注册页", mode: "plan" });
    await h.submit({ projectName: "demo", description: "改登录", mode: "plan", target: "backend_developer" });
    await h.submit.whenIdle();
    const team = h.completed.find((item) => item.agentKey === "project_manager");
    const single = h.completed.find((item) => item.agentKey === "backend_developer");
    assert.equal(team.payload.context.requireHumanApproval, true);
    assert.equal(team.payload.approvalRequired, false, "the PM only waits when it actually dispatches");
    assert.equal(single.payload.context.requireHumanApproval, true);
    assert.equal(single.payload.approvalRequired, true);
    assert.equal(single.payload.delivery.next, "按上述方案执行");
  } finally { await h.cleanup(); }
});

function orchestratorHarness(respond = () => ({ text: "ok", delivery: { summary: "完成", artifactPaths: [], final: false } })) {
  const runs = [];
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent, prompt, context) => { runs.push({ key: agent.key, prompt, context }); return respond(agent.key, prompt); },
    onEvent: async (event) => events.push(event),
    log: quiet,
  });
  for (const key of ["project_manager", "backend_developer", "tester", "auditor"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  return { orch, runs, events };
}

test("a single-bot task settles after that bot delivers instead of following routes to other roles", async () => {
  const { orch, runs, events } = orchestratorHarness();
  await orch.onTaskCompleted("backend_developer", "T-single", { delivery: { agentKey: "backend_developer", summary: "修好了", next: "交给测试验证", artifactPaths: [] }, context: { chatId: "desktop-local", channel: "desktop", singleRole: true } });
  await orch.whenIdle();
  assert.deepEqual(runs, []);
  assert.ok(events.some((event) => event.type === "task_settle" && event.reason === "single_role"));
});

test("approving a single-bot plan from the desktop runs it again on the same runtime, then settles", async () => {
  const { orch, runs, events } = orchestratorHarness();
  const host = createDesktopHost({ token: "desktop-session-token-for-tests", taskStore: { list: async () => [] }, orchestrator: orch, recordEvent: async (event) => events.push(event) });
  await orch.onTaskCompleted("backend_developer", "T-plan", {
    delivery: { agentKey: "backend_developer", summary: "方案：改 auth.js", next: "按上述方案执行", artifactPaths: [] },
    context: { chatId: "desktop-local", channel: "desktop", requireHumanApproval: true, singleRole: true, runtime: "rpc" },
    approvalRequired: true,
  });
  assert.ok(events.some((event) => event.type === "approval_required" && event.task_id === "T-plan"));
  assert.deepEqual(runs, [], "nothing runs before confirmation");
  await assert.rejects(host.commandHandlers.approve_task({ taskId: "T-other" }), /没有等待确认/);
  const approved = await host.commandHandlers.approve_task({ taskId: "T-plan" });
  assert.equal(approved.approved, true);
  await orch.whenIdle();
  assert.deepEqual(runs.map((run) => run.key), ["backend_developer"]);
  assert.equal(runs[0].context.runtime, "rpc");
  assert.match(runs[0].prompt, /按上述方案执行/);
  assert.ok(events.some((event) => event.type === "task_settle" && event.reason === "single_role"));
});

test("in plan mode the PM's dispatch waits for desktop approval and dispatched bots inherit the runtime", async () => {
  const { orch, runs, events } = orchestratorHarness((key, prompt) => key === "project_manager" && /最终汇总/.test(prompt)
    ? { text: "ok", delivery: { summary: "全部完成", artifactPaths: [], final: true } }
    : { text: "ok", delivery: { summary: `${key} 完成`, artifactPaths: [], final: true } });
  await orch.onTaskCompleted("project_manager", "T-team", {
    delivery: { agentKey: "project_manager", summary: "计划", assignments: [{ agentKey: "backend_developer", task: "实现注册接口" }], artifactPaths: [] },
    context: { chatId: "desktop-local", channel: "desktop", requireHumanApproval: true, runtime: "rpc" },
  });
  assert.deepEqual(runs, []);
  assert.ok(events.some((event) => event.type === "approval_required"));
  assert.ok(await orch.resolveLatest("desktop-local", "approve", "T-team"));
  await orch.whenIdle();
  assert.equal(runs[0].key, "backend_developer");
  assert.equal(runs[0].context.runtime, "rpc");
});
