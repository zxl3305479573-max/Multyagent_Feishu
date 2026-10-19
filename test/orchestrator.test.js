import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, matchRoutes } from "../src/orchestrator.js";
import { buildResultCard } from "../src/gateway.js";
import { artifactsDirFor } from "../src/artifacts.js";
import { readProjectSummary } from "../src/project-summary.js";
import { _resetForTest, createTask, setPaused, setTerminated } from "../src/tasks.js";

const routes = [
  { from: "project_manager", to: ["architect"] },
  { from: "architect", to: ["frontend_developer", "backend_developer"] },
  { from: ["frontend_developer", "backend_developer"], to: ["tester"], when: "all_done" },
  { from: "tester", to: ["auditor"] },
];

test("matchRoutes：单上游单下游", () => {
  assert.deepEqual(matchRoutes(routes, "project_manager"), [
    { froms: ["project_manager"], tos: ["architect"], when: "always" },
  ]);
});

test("matchRoutes：一对多并行", () => {
  assert.deepEqual(matchRoutes(routes, "architect"), [
    { froms: ["architect"], tos: ["frontend_developer", "backend_developer"], when: "always" },
  ]);
});

test("matchRoutes：汇聚规则（多上游）", () => {
  const matched = matchRoutes(routes, "frontend_developer");
  assert.equal(matched.length, 1);
  assert.equal(matched[0].when, "all_done");
  assert.deepEqual(matched[0].froms, ["frontend_developer", "backend_developer"]);
});

test("matchRoutes：无匹配返回空", () => {
  assert.deepEqual(matchRoutes(routes, "unknown_role"), []);
});

// 测试角色在项目经理主导的任务链里必须提交结构化验收结果。
const PASSED_ACCEPTANCE = { verdict: "pass", summary: "全部通过", checks: [{ id: "AC1", title: "核心流程", status: "pass" }], evidence: [{ kind: "command", text: "npm test：12/12 通过" }] };

function setupMock() {
  const dispatched = [];
  const runAgent = async (agent) => {
    dispatched.push(agent.key);
    return {
      text: `${agent.key} done`,
      delivery: { summary: "x", artifactPaths: [], artifactsDir: "runtime/artifacts/t", final: true },
      projectName: null,
    };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  for (const key of ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"]) {
    orch.registerRole({ key, displayName: key, appId: "cli_x" }, client);
  }
  return { orch, dispatched };
}

test("汇聚屏障：单端完成不派发下游", async () => {
  const { orch, dispatched } = setupMock();
  const context = { chatId: "c1" };
  const delivery = { summary: "x", artifactPaths: [], artifactsDir: "runtime/artifacts/t" };
  await orch.onTaskCompleted("frontend_developer", "T:architect:frontend_developer", {
    delivery,
    context,
    parentTaskId: "T:architect",
  });
  assert.ok(!dispatched.includes("tester"), "仅前端完成不应派发 tester");
});

test("汇聚屏障：两端都完成才派发一次 tester", async () => {
  const { orch, dispatched } = setupMock();
  const context = { chatId: "c1" };
  const delivery = { summary: "x", artifactPaths: [], artifactsDir: "runtime/artifacts/t" };
  await orch.onTaskCompleted("frontend_developer", "T:architect:frontend_developer", {
    delivery, context, parentTaskId: "T:architect",
  });
  await orch.onTaskCompleted("backend_developer", "T:architect:backend_developer", {
    delivery, context, parentTaskId: "T:architect",
  });
  assert.equal(dispatched.filter((k) => k === "tester").length, 1, "两端都完成应派发 tester 恰好一次");
});

test("不同父任务的汇聚状态互不干扰", async () => {
  const { orch, dispatched } = setupMock();
  const context = { chatId: "c1" };
  const delivery = { summary: "x", artifactPaths: [], artifactsDir: "runtime/artifacts/t" };
  await orch.onTaskCompleted("frontend_developer", "T1:x:frontend_developer", { delivery, context, parentTaskId: "T1:x" });
  await orch.onTaskCompleted("backend_developer", "T2:x:backend_developer", { delivery, context, parentTaskId: "T2:x" });
  assert.equal(dispatched.filter((k) => k === "tester").length, 0, "不同父任务不应触发汇聚");
});

test("final 标记终止派发", async () => {
  const { orch, dispatched } = setupMock();
  await orch.onTaskCompleted("project_manager", "T", {
    delivery: { summary: "汇聚完成", artifactPaths: [], artifactsDir: "d", final: true },
    context: { chatId: "c1" },
  });
  assert.equal(dispatched.length, 0, "final 交付不应再派发下游");
});

test("派发时发送接收回执（让派发在群里可见）", async () => {
  const messages = [];
  const client = {
    im: {
      message: {
        create: async (args) => {
          messages.push({ type: args.data.msg_type, content: JSON.parse(args.data.content) });
          return { code: 0, data: { message_id: "m1" } };
        },
      },
    },
  };
  const runAgent = async () => ({
    text: "x",
    delivery: { summary: "x", artifactPaths: [], artifactsDir: "d", final: true },
    projectName: null,
  });
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log, maxRounds: 3 });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T", {
    delivery: { summary: "计划完成", artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  assert.ok(
    messages.some((m) => m.type === "interactive" && JSON.stringify(m.content).includes("已接收")),
    `应发送接收回执，实际: ${messages.join(" | ")}`,
  );
});

test("桌面通道派发只记录事件，不向飞书发送卡片", async () => {
  let messages = 0;
  let ran = 0;
  const client = { im: { message: { create: async () => { messages += 1; return { code: 0 }; } } } };
  const orch = createOrchestrator({
    runAgent: async () => { ran += 1; return { text: "done", delivery: { summary: "done", artifactPaths: [], next: "无需后续操作", final: true } }; },
    log: { info() {}, error() {}, warn() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "AR", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-desktop", {
    delivery: { summary: "plan", assignments: [{ agentKey: "architect", task: "design" }], artifactPaths: [], next: "执行计划" },
    context: { chatId: "desktop-local", channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  // 架构设计师完成后必须回到项目经理汇总：桌面端同样只产生事件，不发飞书卡片。
  assert.equal(ran, 2);
  assert.equal(messages, 0);
});

test("未接入飞书的角色（client 为空）可处理桌面任务，但不接飞书任务", async () => {
  let ran = 0;
  const orch = createOrchestrator({
    runAgent: async () => { ran += 1; return { text: "done", delivery: { summary: "done", artifactPaths: [], next: "无需后续操作", final: true } }; },
    log: { info() {}, error() {}, warn() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM" }, null);
  orch.registerRole({ key: "architect", displayName: "AR" }, null);
  await orch.onTaskCompleted("project_manager", "T-nofeishu-desktop", {
    delivery: { summary: "plan", assignments: [{ agentKey: "architect", task: "design" }], artifactPaths: [], next: "执行计划" },
    context: { chatId: "desktop-local", channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  assert.equal(ran, 2);

  ran = 0;
  await orch.onTaskCompleted("project_manager", "T-nofeishu-chat", {
    delivery: { summary: "plan", assignments: [{ agentKey: "architect", task: "design" }], artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  await orch.whenIdle();
  assert.equal(ran, 0);
});

test("dispatch_started events include the assigned task but not the generated prompt", async () => {
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async () => ({ text: "done", delivery: { summary: "done", final: true, artifactPaths: [], artifactsDir: "d" } }),
    onEvent: async (event) => events.push(event),
    log: { info() {}, error() {}, warn() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "AR", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-dispatch-trace", {
    delivery: { summary: "Plan ready", assignments: [{ agentKey: "architect", task: "Design the service API" }], artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  const started = events.find((event) => event.type === "dispatch_started");
  assert.equal(started.assigned_task, "Design the service API");
  assert.equal("prompt" in started, false);
});

test("structured PM plans execute stages sequentially while assignments in one stage run in parallel", async () => {
  const dispatched = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => {
      dispatched.push(agent.key);
      return { text: "done", delivery: { summary: "done", artifactPaths: [], artifactsDir: "d", final: agent.key === "project_manager", ...(agent.key === "tester" ? { acceptance: PASSED_ACCEPTANCE } : {}) } };
    },
    log: { info() {}, error() {}, warn() {} },
  });
  for (const key of ["project_manager", "architect", "tester"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  const plan = { project: "demo", goal: "verify", stages: [
    { id: "design", assignments: [{ id: "design", agentKey: "architect", task: "design" }] },
    { id: "verify", assignments: [{ id: "verify", agentKey: "tester", task: "verify", dependsOn: ["design"] }] },
  ] };
  await orch.onTaskCompleted("project_manager", "T-plan", { delivery: { summary: "plan", plan, assignments: [{ id: "design", agentKey: "architect", task: "design" }], artifactPaths: [], artifactsDir: "d" }, context: { chatId: "c1", projectName: "demo" } });
  assert.deepEqual(dispatched, ["architect", "tester", "project_manager"]);
  await orch.whenIdle();
  assert.deepEqual(dispatched, ["architect", "tester", "project_manager"]);
});

test("根任务暂停时不派发下游", async () => {
  _resetForTest("runtime/tasks.orch.test.json");
  const task = await createTask({ agentKey: "project_manager", chatId: "c1", rootKey: "m1", messageId: "m1" });
  await setPaused(task.taskId, true);
  const { orch, dispatched } = setupMock();
  await orch.onTaskCompleted("project_manager", task.taskId, {
    delivery: { summary: "x", artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  assert.equal(dispatched.length, 0, "暂停时不应派发下游");
  rmSync("runtime/tasks.orch.test.json", { force: true });
});

test("暂停时保存交付检查点，恢复后恰好派发一次", async () => {
  const checkpointFile = "runtime/checkpoints.orch.test.json";
  rmSync(checkpointFile, { force: true });
  _resetForTest("runtime/tasks.checkpoint.orch.test.json");
  const task = await createTask({ agentKey: "project_manager", chatId: "c1", rootKey: "m-checkpoint", messageId: "m-checkpoint" });
  await setPaused(task.taskId, true);
  const dispatched = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => {
      dispatched.push(agent.key);
      return { text: "done", delivery: { summary: "done", final: true, artifactPaths: [], artifactsDir: "d" } };
    },
    log: { info() {}, error() {}, warn() {} },
    checkpointFile,
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "AR", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", task.taskId, {
    delivery: { summary: "plan", assignments: [{ agentKey: "architect", task: "implement" }], artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  assert.deepEqual(dispatched, []);
  assert.equal(await orch.resumeTask(task.taskId), 1);
  await orch.whenIdle();
  assert.deepEqual(dispatched, ["architect", "project_manager"]);
  assert.equal(await orch.resumeTask(task.taskId), 0);
  await orch.whenIdle();
  assert.deepEqual(dispatched, ["architect", "project_manager"]);
  rmSync(checkpointFile, { force: true });
  rmSync("runtime/tasks.checkpoint.orch.test.json", { force: true });
});

test("终止的根任务不会再启动任何下游派发", async () => {
  _resetForTest("runtime/tasks.terminated.orch.test.json");
  const task = await createTask({ agentKey: "project_manager", chatId: "c1", rootKey: "m-terminated", messageId: "m-terminated" });
  await setTerminated(task.taskId, true);
  const { orch, dispatched } = setupMock();
  await orch.onTaskCompleted("project_manager", task.taskId, {
    delivery: { summary: "x", assignments: [{ agentKey: "architect", task: "x" }], artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1" },
  });
  assert.equal(dispatched.length, 0);
  rmSync("runtime/tasks.terminated.orch.test.json", { force: true });
});

test("不存在的任务不会被伪确认为已恢复", async () => {
  _resetForTest("runtime/tasks.missing.orch.test.json");
  const orch = createOrchestrator({ runAgent: async () => ({}), log: { info() {}, error() {}, warn() {} } });
  assert.equal(await orch.resumeTask("missing-task"), null);
  rmSync("runtime/tasks.missing.orch.test.json", { force: true });
});

test("轮次上限终止派发（防死循环）", async () => {
  const dispatched = [];
  const runAgent = async (agent) => {
    dispatched.push(agent.key);
    return { text: "x", delivery: { summary: "x", artifactPaths: [], artifactsDir: "d" }, projectName: null };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log, maxRounds: 1 });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "AR", appId: "x" }, client);
  const delivery = { summary: "x", artifactPaths: [], artifactsDir: "d" };
  // 对同一个根任务连续触发 5 次完成事件
  for (let i = 0; i < 5; i++) {
    await orch.onTaskCompleted("project_manager", `T:step${i}`, { delivery, context: { chatId: "c1" } });
  }
  assert.equal(dispatched.length, 1, `maxRounds=1 应只派发 1 次，实际 ${dispatched.length}`);
});

test("PM 交付只有 choices、没有 assignments 时，按钮点击仍能解析（不再提前结算）", async () => {
  const runs = [];
  const runAgent = async (agent, prompt) => {
    runs.push({ key: agent.key, prompt });
    return {
      text: "继续",
      delivery: { summary: "已按用户选择推进", artifactPaths: [], artifactsDir: "d", final: true },
      projectName: null,
    };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);

  const delivery = {
    agentKey: "project_manager",
    agentName: "项目经理",
    summary: "需求待澄清",
    artifactPaths: ["workspace/default/artifacts/T-ask/PROJECT.md"],
    artifactsDir: "workspace/default/artifacts/T-ask",
    choices: [
      { id: "detail", label: "我先补充需求细节" },
      { id: "typical", label: "按典型学生管理系统起步" },
    ],
    assignments: [],
  };

  await orch.onTaskCompleted("project_manager", "T-ask", {
    delivery,
    context: { chatId: "c1", requireHumanApproval: true },
  });

  // 直接用卡片上真实渲染出来的按钮 value，验证「按钮 → 待确认」这条接缝
  const card = buildResultCard({ delivery });
  const button = card.body.elements.find((element) => element.tag === "action").actions[1];
  assert.equal(button.value.action, "choice");

  const resolved = await orch.resolveLatest("c1", button.value.choice);
  assert.equal(resolved?.approved, true, "带 choices 的卡片必须能取到待确认项");
  await orch.whenIdle();
  assert.equal(runs.length, 1, "应把用户选择交回项目经理继续推进");
  assert.match(runs[0].prompt, new RegExp(button.value.choice));
});

test("非 PM 角色有真实 choices 时，卡片按钮能取到待确认项", async () => {
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async () => ({
    text: "x",
    delivery: { summary: "x", artifactPaths: [], artifactsDir: "d", final: true },
    projectName: null,
  });
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  for (const key of ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"]) {
    orch.registerRole({ key, displayName: key, appId: "x" }, client);
  }

  await orch.onTaskCompleted("tester", "T:architect:tester", {
    delivery: { summary: "测试通过", choices: [{ id: "approve", label: "确认执行" }], artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1", requireHumanApproval: true },
  });

  const resolved = await orch.resolveLatest("c1", "approve");
  assert.equal(resolved?.approved, true);
  assert.equal(resolved?.agentKey, "tester");
});

test("非 PM 的下一步交回项目经理，由项目经理派发后完成测试、审计和汇总", async () => {
  const runs = [];
  const prompts = [];
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async (agent, prompt) => {
    runs.push(agent.key);
    prompts.push({ key: agent.key, prompt });
    if (agent.key === "project_manager") {
      if (!runs.includes("tester")) {
        return {
          text: "计划已定",
          delivery: {
            agentKey: agent.key,
            summary: "派发测试复验",
            assignments: [{ agentKey: "tester", task: "复验后端修复" }],
            artifactPaths: [],
          },
        };
      }
      return { text: "最终汇总", delivery: { agentKey: agent.key, summary: "全部复验完成", final: true, artifactPaths: [] } };
    }
    return { text: `${agent.key} 完成`, delivery: { agentKey: agent.key, summary: `${agent.key} 完成`, final: false, artifactPaths: [] } };
  };
  const orch = createOrchestrator({ runAgent, log: { info() {}, error() {}, warn() {} }, onEvent: async (event) => events.push(event) });
  for (const key of ["backend_developer", "tester", "auditor", "project_manager"]) {
    orch.registerRole({ key, displayName: key, appId: "x" }, client);
  }

  await orch.onTaskCompleted("backend_developer", "T-flow:backend_developer", {
    delivery: {
      agentKey: "backend_developer",
      summary: "后端修复已完成",
      next: "派发测试复验，最后由项目经理总结",
      artifactPaths: [],
    },
    parentTaskId: "T-flow",
    context: {
      chatId: "flow-chat",
      requireHumanApproval: true,
      selectedAgents: ["backend_developer", "tester"],
    },
  });

  assert.equal((await orch.resolveLatest("flow-chat", "approve"))?.approved, true);
  await orch.whenIdle();

  assert.deepEqual(runs, ["project_manager", "tester", "auditor", "project_manager"]);
  assert.match(prompts[0].prompt, /后端修复已完成/);
  assert.match(prompts[0].prompt, /派发测试复验/);
  assert.match(prompts[0].prompt, /上游建议的下一步/);
  assert.match(prompts.find((item) => item.key === "project_manager" && /tester 完成/.test(item.prompt)).prompt, /逐项汇总已完成内容/);
  assert.ok(events.some((event) => event.type === "task_settle" && event.reason === "final"));
});

test("下游机器人未调用 deliver_artifact 时也用普通回复继续路由", async () => {
  const runs = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => {
      runs.push(agent.key);
      if (agent.key === "tester") return { text: "测试机器人已完成复验" };
      return { text: "审计机器人已完成审计" };
    },
    log: { info() {}, warn() {}, error() {} },
  });
  orch.registerRole({ key: "tester", displayName: "测试", appId: "x" }, client);
  orch.registerRole({ key: "auditor", displayName: "审计", appId: "x" }, client);
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  await orch.onTaskCompleted("tester", "T-fallback:tester", {
    delivery: { agentKey: "tester", summary: "测试任务已派发", artifactPaths: [] },
    parentTaskId: "T-fallback",
    context: { chatId: "fallback-chat" },
  });
  await orch.whenIdle();
  assert.deepEqual(runs, ["auditor", "project_manager"]);
});

test("resolveLatest 按 task_id 精确解析同群待确认任务，旧卡片仍按最新项解析", async () => {
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async () => ({ text: "done", delivery: { summary: "done", final: true }, projectName: null });
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);
  orch.registerRole({ key: "tester", displayName: "测试", appId: "x" }, client);
  const context = { chatId: "same-chat", requireHumanApproval: true };
  const choices = [{ id: "approve", label: "确认执行" }];
  await orch.onTaskCompleted("architect", "task-old", { delivery: { summary: "old", choices }, context });
  await orch.onTaskCompleted("tester", "task-new", { delivery: { summary: "new", choices }, context });

  const targeted = await orch.resolveLatest("same-chat", "approve", "task-old");
  assert.equal(targeted?.taskId, "task-old");
  const legacy = await orch.resolveLatest("same-chat", "approve");
  assert.equal(legacy?.taskId, "task-new");
  assert.equal(await orch.resolveLatest("same-chat", "approve", "missing"), null);
});

test("PM 交付既无 assignments 也无 choices 且无审批上下文时仍结算 no_assignments（不回归）", async () => {
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async () => ({ text: "x", delivery: { summary: "x" }, projectName: null });
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log, onEvent: async (event) => events.push(event) });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);

  await orch.onTaskCompleted("project_manager", "T-empty", {
    delivery: { summary: "无待办", artifactPaths: [], artifactsDir: "d", assignments: [] },
    context: { chatId: "c1" },
  });

  assert.ok(events.some((e) => e.type === "task_settle" && e.reason === "no_assignments"));
  assert.equal(await orch.resolveLatest("c1"), null);
});

test("PM 交付只有 next 时自动继续由项目经理执行，不出确认卡", async () => {
  const runs = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async (agent) => {
    runs.push(agent.key);
    return {
      text: "收尾",
      delivery: { summary: "已收尾", artifactPaths: [], artifactsDir: "d", final: true },
      projectName: null,
    };
  };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);

  await orch.onTaskCompleted("project_manager", "T-noop", {
    delivery: { agentKey: "project_manager", summary: "无需派发", next: "确认后继续执行", artifactPaths: [], artifactsDir: "d", assignments: [] },
    context: { chatId: "c1", requireHumanApproval: true },
  });

  assert.equal(await orch.resolveLatest("c1", "approve"), null, "普通 next 不应登记待确认项");
  await orch.whenIdle();
  assert.deepEqual(runs, ["project_manager"], "PM 的 next 应自动续跑，而不是派发给配置路由");
});

test("派发下游时继承上游交付的项目名，产物目录与该角色白名单保持一致", async () => {
  const runs = [];
  const runAgent = async (agent, prompt, context) => {
    runs.push({ key: agent.key, context });
    return {
      text: "done",
      delivery: { agentKey: agent.key, summary: "done", artifactPaths: [], artifactsDir: context.artifactsDir, final: true },
      projectName: context.projectName,
    };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  for (const key of ["project_manager", "architect"]) {
    orch.registerRole({ key, displayName: key, appId: "x" }, client);
  }

  // 上游交付包写着项目名 student，但产物目录还停在 default（项目是这一轮才创建的）
  await orch.onTaskCompleted("project_manager", "T-proj", {
    delivery: {
      agentKey: "project_manager",
      summary: "计划就绪",
      artifactPaths: ["workspace/default/artifacts/T-proj/PROJECT.md"],
      artifactsDir: "workspace/default/artifacts/T-proj",
      projectName: "student",
      assignments: [{ agentKey: "architect", task: "产出接口契约" }],
    },
    context: { chatId: "c1", requireHumanApproval: true },
  });

  await orch.resolveLatest("c1", "approve");
  await orch.whenIdle();

  assert.equal(runs.length, 2, "下游完成后回到项目经理汇总");
  assert.equal(runs[0].key, "architect");
  assert.equal(runs[0].context.projectName, "student", "下游必须继承上游交付的项目名，否则写入白名单会解析成 default");
  assert.equal(runs[0].context.artifactsDir, artifactsDirFor("T-proj", "student"));
});

test("下游派发提示词使用中文并禁止输出英文内部工作日志", async () => {
  const prompts = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async (agent, value) => {
    prompts.push({ key: agent.key, prompt: value });
    return { text: "完成", delivery: { summary: "完成", artifactPaths: [], artifactsDir: "d", final: true } };
  };
  const orch = createOrchestrator({ runAgent, log: { info() {}, error() {}, warn() {} } });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);

  await orch.onTaskCompleted("project_manager", "T-prompt", {
    delivery: {
      agentKey: "project_manager",
      summary: "计划完成",
      artifactsDir: "d",
      artifactPaths: [],
      assignments: [{ agentKey: "architect", task: "产出架构方案" }],
    },
    context: { chatId: "c-prompt", requireHumanApproval: false },
  });
  await orch.whenIdle();
  const prompt = prompts.find((item) => item.key === "architect").prompt;
  assert.match(prompt, /分配任务：产出架构方案/);
  assert.match(prompt, /不要输出思考过程、工具调用过程、英文工作日志/);
  assert.doesNotMatch(prompt, /Assigned task:|Upstream agent:|Previous agent deliveries:/);
});

test("上游本轮切换项目时，新项目名覆盖旧上下文并传给下游", async () => {
  const runs = [];
  const runAgent = async (agent, prompt, context) => {
    runs.push({ key: agent.key, context });
    return {
      text: "done",
      delivery: { agentKey: agent.key, summary: "done", artifactPaths: [], artifactsDir: context.artifactsDir, final: true },
      projectName: context.projectName,
    };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  for (const key of ["project_manager", "architect"]) {
    orch.registerRole({ key, displayName: key, appId: "x" }, client);
  }

  await orch.onTaskCompleted("project_manager", "T-project-switch", {
    delivery: {
      agentKey: "project_manager",
      summary: "切换项目后的计划",
      artifactPaths: ["workspace/student/artifacts/T-project-switch/PROJECT.md"],
      artifactsDir: "workspace/student/artifacts/T-project-switch",
      projectName: "student",
      assignments: [{ agentKey: "architect", task: "产出接口契约" }],
    },
    context: { chatId: "c-switch", projectName: "default", requireHumanApproval: true },
  });

  await orch.resolveLatest("c-switch", "approve");
  await orch.whenIdle();

  assert.equal(runs.length, 2, "下游完成后回到项目经理汇总");
  assert.equal(runs[0].context.projectName, "student");
  assert.equal(runs[0].context.artifactsDir, artifactsDirFor("T-project-switch", "student"));
});

test("resolveLatest 立刻返回，不阻塞卡片回调（耗时推进在后台）", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished = false;
  const runAgent = async () => {
    await gate;
    finished = true;
    return {
      text: "继续",
      delivery: { summary: "已推进", artifactPaths: [], artifactsDir: "d", final: true },
      projectName: null,
    };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);

  await orch.onTaskCompleted("project_manager", "T-slow", {
    delivery: {
      agentKey: "project_manager",
      summary: "待澄清",
      artifactPaths: [],
      artifactsDir: "d",
      choices: [{ id: "typical", label: "按典型方案起步" }],
      assignments: [],
    },
    context: { chatId: "c1", requireHumanApproval: true },
  });

  const resolved = await orch.resolveLatest("c1", "typical");
  assert.equal(resolved?.approved, true);
  assert.equal(finished, false, "回调必须在 Agent 跑完之前返回，否则飞书会超时");
  release();
  await orch.whenIdle();
  assert.equal(finished, true, "后台推进最终要跑完");
});

test("确认卡后台续跑发出开始和完成事件", async () => {
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async () => ({ text: "done", delivery: { summary: "done", final: true } }),
    onEvent: async (event) => events.push(event),
    log: { info() {}, error() {}, warn() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-continuation", {
    delivery: { summary: "待确认", choices: [{ id: "approve", label: "确认" }] },
    context: { chatId: "c-continuation", requireHumanApproval: true },
  });
  await orch.resolveLatest("c-continuation", "approve");
  await orch.whenIdle();
  const continuation = events.filter((event) => event.type.startsWith("continuation_"));
  assert.deepEqual(continuation.map((event) => event.type), ["continuation_started", "continuation_completed"]);
});

test("确认卡后台续跑失败发出开始和失败事件", async () => {
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async () => { throw new Error("continuation boom"); },
    onEvent: async (event) => events.push(event),
    log: { info() {}, error() {}, warn() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-continuation-fail", {
    delivery: { summary: "待确认", choices: [{ id: "approve", label: "确认" }] },
    context: { chatId: "c-continuation-fail", requireHumanApproval: true },
  });
  await orch.resolveLatest("c-continuation-fail", "approve");
  await orch.whenIdle();
  const continuation = events.filter((event) => event.type.startsWith("continuation_"));
  assert.deepEqual(continuation.map((event) => event.type), ["continuation_started", "continuation_failed"]);
  assert.equal(continuation.at(-1).error, "continuation boom");
});

test("待确认项落盘后，重启进程仍能点击确认", async () => {
  const file = "runtime/approvals.test.json";
  rmSync(file, { force: true });
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, error() {}, warn() {} };
  try {
    // 第一个「进程」：登记待确认项
    const first = createOrchestrator({ runAgent: async () => ({ text: "x" }), log, approvalsFile: file });
    for (const key of ["project_manager", "architect"]) first.registerRole({ key, displayName: key, appId: "x" }, client);
    await first.onTaskCompleted("project_manager", "T-persist", {
      delivery: {
        agentKey: "project_manager",
        summary: "计划就绪",
        artifactPaths: [],
        artifactsDir: "d",
        assignments: [{ agentKey: "architect", task: "产出契约" }],
      },
      context: { chatId: "c1", requireHumanApproval: true },
    });

    // 第二个「进程」：重启后应能读到并放行
    const dispatched = [];
    const second = createOrchestrator({
      runAgent: async (agent) => {
        dispatched.push(agent.key);
        return { text: "x", delivery: { summary: "done", artifactPaths: [], artifactsDir: "d", final: true } };
      },
      log,
      approvalsFile: file,
    });
    for (const key of ["project_manager", "architect"]) second.registerRole({ key, displayName: key, appId: "x" }, client);

    const resolved = await second.resolveLatest("c1", "approve");
    assert.equal(resolved?.approved, true, "重启后旧卡片必须仍能确认");
    await second.whenIdle();
    assert.deepEqual(dispatched, ["architect", "project_manager"], "恢复后正常放行下游，并由项目经理汇总收尾");
  } finally {
    rmSync(file, { force: true });
  }
});

test("超过 TTL 的待确认项在恢复时被丢弃", async () => {
  const file = "runtime/approvals.ttl.test.json";
  writeFileSync(file, JSON.stringify({
    pending: {
      "c1:T-old": {
        agentKey: "architect",
        taskId: "T-old",
        delivery: { summary: "很久以前" },
        context: { chatId: "c1" },
        savedAt: Date.now() - 48 * 60 * 60 * 1000,
      },
    },
  }));
  try {
    const orch = createOrchestrator({ runAgent: async () => ({ text: "x" }), log: { info() {}, error() {}, warn() {} }, approvalsFile: file });
    assert.equal(await orch.resolveLatest("c1"), null, "过期项不应被恢复");
  } finally {
    rmSync(file, { force: true });
  }
});

test("不传 approvalsFile 时不落盘", async () => {
  const file = "runtime/approvals.unused.test.json";
  rmSync(file, { force: true });
  const orch = createOrchestrator({ runAgent: async () => ({ text: "x" }), log: { info() {}, error() {}, warn() {} } });
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, { im: { message: { create: async () => ({ code: 0 }) } } });
  await orch.onTaskCompleted("architect", "T-x", {
    delivery: { summary: "x", artifactPaths: [] },
    context: { chatId: "c1", requireHumanApproval: true },
  });
  assert.equal(existsSync(file), false, "未指定路径时不应写文件");
});

test("所有下游派发结束后根任务收到结算事件，不会永久停在执行中", async () => {
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => ({
      text: "done",
      delivery: { agentKey: agent.key, summary: `${agent.key} done`, artifactPaths: [], final: agent.key !== "architect" },
    }),
    onEvent: async (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "AR", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-settle-root", {
    delivery: { agentKey: "project_manager", summary: "plan", assignments: [{ agentKey: "architect", task: "design" }], artifactPaths: [], next: "执行计划" },
    context: { chatId: "desktop-local", channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  assert.ok(
    events.some((event) => event.type === "task_settle" && event.task_id === "T-settle-root"),
    `根任务应收到结算事件，实际: ${events.map((event) => event.type).join(",")}`,
  );
});

test("parallel root settlement waits for the blocked sibling and occurs once", async () => {
  const events = [];
  let releaseAuditor;
  let testerFinished;
  const gate = new Promise((resolve) => { releaseAuditor = resolve; });
  const finished = new Promise((resolve) => { testerFinished = resolve; });
  const orch = createOrchestrator({
    runAgent: async (agent) => {
      if (agent.key === "auditor") await gate;
      return { text: "done", delivery: { summary: "done", final: true } };
    },
    onEvent: async (event) => {
      events.push(event);
      if (event.type === "delivery_received" && event.agent === "tester") testerFinished();
    },
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "tester", "auditor"]) orch.registerRole({ key, displayName: key }, {});
  const work = orch.onTaskCompleted("project_manager", "T-parallel-settle", {
    delivery: { summary: "plan", assignments: [{ agentKey: "tester", task: "test" }, { agentKey: "auditor", task: "audit" }] },
    context: { channel: "desktop" },
  });
  try {
    await finished;
    assert.equal(events.some((event) => event.type === "task_settle" && event.task_id === "T-parallel-settle"), false);
  } finally { releaseAuditor(); await work; }
  const settlements = events.filter((event) => event.type === "task_settle" && event.task_id === "T-parallel-settle");
  assert.equal(settlements.length, 1);
  assert.ok(events.indexOf(settlements[0]) > events.findIndex((event) => event.type === "delivery_received" && event.agent === "auditor"));
});

test("项目经理无显式 assignments 时不沿静态路由派发", async () => {
  const dispatched = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => { dispatched.push(agent.key); return { text: "done", delivery: { summary: "done", artifactPaths: [], final: true } }; },
    log: { info() {}, warn() {}, error() {} },
  });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-pm-only", {
    delivery: { agentKey: "project_manager", summary: "项目经理已完成", artifactPaths: [], next: "无需后续操作" },
    context: { chatId: "c-pm-only", channel: "desktop" },
  });
  await orch.whenIdle();
  assert.deepEqual(dispatched, []);
});

test("PM 自己能做的 next 自动续跑，不派发下游，也不出确认卡", async () => {
  const runs = [];
  const prompts = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async (agent, prompt) => {
    runs.push(agent.key);
    prompts.push(prompt);
    return {
      text: "需求规格已完成",
      delivery: { agentKey: agent.key, summary: "需求规格已完成", final: true, artifactPaths: [] },
    };
  };
  const orch = createOrchestrator({ runAgent, log: { info() {}, warn() {}, error() {} } });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, client);
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);

  await orch.onTaskCompleted("project_manager", "T-pm-self", {
    delivery: {
      agentKey: "project_manager",
      summary: "目标已定",
      next: "由项目经理补充范围、交付边界与验收标准",
      artifactPaths: [],
    },
    context: { chatId: "c-pm-self", requireHumanApproval: true },
  });

  assert.equal(await orch.resolveLatest("c-pm-self", "approve"), null, "普通 next 不应登记待确认项");
  await orch.whenIdle();
  assert.deepEqual(runs, ["project_manager"], "PM 自己能做的下一步不应派发给架构设计师");
  assert.match(prompts[0], /由项目经理补充范围、交付边界与验收标准/);
});

test("每个阶段交付后自动追加项目摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-summary-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    const client = { im: { message: { create: async () => ({ code: 0 }) } } };
    const orch = createOrchestrator({ runAgent: async () => ({ text: "x" }), log: { info() {}, warn() {}, error() {} } });
    orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);
    await orch.onTaskCompleted("architect", "T-sum", {
      delivery: {
        agentKey: "architect",
        summary: "架构图完成",
        artifactPaths: ["workspace/student/artifacts/T-sum/architecture.md"],
        projectName: "student",
        final: true,
      },
      context: { chatId: "c-sum", projectName: "student" },
    });
    const summary = await readProjectSummary({ root, projectName: "student" });
    assert.match(summary.content, /架构图完成/);
    assert.match(summary.content, /workspace\/student\/artifacts\/T-sum\/architecture.md/);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("非 PM 角色声明 final 时，根任务仍回到项目经理做最终汇总", async () => {
  const file = "runtime/tasks.final-handback.test.json";
  _resetForTest(file);
  const events = [];
  const runs = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent, prompt) => {
      runs.push({ key: agent.key, prompt });
      return { text: "done", delivery: { agentKey: agent.key, summary: `${agent.key} 完成`, artifactPaths: [], final: agent.key === "project_manager" } };
    },
    onEvent: async (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "tester"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);

  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "chat-final", rootKey: "m-final", messageId: "m-final" });
    await orch.onTaskCompleted("tester", `${task.taskId}:tester`, {
      delivery: { agentKey: "tester", summary: "测试通过，无需后续", artifactPaths: [], final: true, acceptance: PASSED_ACCEPTANCE },
      parentTaskId: task.taskId,
      context: { chatId: "chat-final" },
    });
    await orch.whenIdle();

    assert.ok(events.some((event) => event.type === "final_deferred" && event.agent === "tester"), "非 PM 的 final 应被延后，不能直接结束整条链");
    assert.equal(runs.at(-1)?.key, "project_manager", "所有角色完成后必须回到项目经理");
    assert.match(runs.at(-1).prompt, /最终汇总/);
  } finally {
    rmSync(file, { force: true });
  }
});

test("结构化计划全部阶段完成后回到项目经理汇总", async () => {
  const file = "runtime/tasks.plan-summary.test.json";
  _resetForTest(file);
  const dispatched = [];
  const prompts = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent, prompt) => {
      dispatched.push(agent.key);
      prompts.push({ key: agent.key, prompt });
      return { text: "done", delivery: { agentKey: agent.key, summary: `${agent.key} 完成`, artifactPaths: [], final: true } };
    },
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "architect", "backend_developer"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);

  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "chat-plan", rootKey: "m-plan", messageId: "m-plan" });
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: {
        agentKey: "project_manager",
        summary: "计划",
        assignments: [{ agentKey: "architect", task: "设计" }, { agentKey: "backend_developer", task: "实现" }],
        artifactPaths: [],
        next: "执行计划",
      },
      context: { chatId: "chat-plan" },
    });
    await orch.whenIdle();

    assert.deepEqual(dispatched, ["architect", "backend_developer", "project_manager"], "阶段全部完成后回到项目经理");
    assert.match(prompts.at(-1).prompt, /最终汇总/);
  } finally {
    rmSync(file, { force: true });
  }
});

test("用户直接 @执行角色的单角色任务仍由该角色收尾，不额外拉起项目经理", async () => {
  const file = "runtime/tasks.single-role.test.json";
  _resetForTest(file);
  const events = [];
  const dispatched = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent) => {
      dispatched.push(agent.key);
      return { text: "done", delivery: { agentKey: agent.key, summary: "完成", artifactPaths: [], final: true } };
    },
    onEvent: async (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "tester"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);

  try {
    const task = await createTask({ agentKey: "tester", chatId: "chat-single", rootKey: "m-single", messageId: "m-single" });
    await orch.onTaskCompleted("tester", task.taskId, {
      delivery: { agentKey: "tester", summary: "测试完成", artifactPaths: [], final: true },
      context: { chatId: "chat-single" },
    });
    await orch.whenIdle();

    assert.deepEqual(dispatched, [], "单角色任务不应额外派发项目经理或下游角色");
    assert.ok(events.some((event) => event.type === "task_settle" && event.task_id === task.taskId && event.reason === "final"));
    assert.equal(events.some((event) => event.type === "final_deferred"), false);
  } finally {
    rmSync(file, { force: true });
  }
});

function failureRecoverySetup({ failTimes }) {
  const events = [];
  const prompts = [];
  let failures = 0;
  let pmRuns = 0;
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent, prompt) => {
      if (agent.key === "project_manager") {
        pmRuns += 1;
        prompts.push(prompt);
        const finalRun = prompt.includes("执行失败") ? failures >= failTimes : pmRuns > 1;
        if (pmRuns === 1 || !finalRun) {
          return { text: "dispatch", delivery: { agentKey: "project_manager", summary: "派发", next: "", artifactPaths: [], assignments: [{ agentKey: "tester", task: "测试" }] } };
        }
        return { text: "done", delivery: { agentKey: "project_manager", summary: "汇总", artifactPaths: [], final: true } };
      }
      if (failures < failTimes) { failures += 1; throw new Error("boom"); }
      return { text: "ok", delivery: { agentKey: agent.key, summary: "测试完成", artifactPaths: [], final: true } };
    },
    onEvent: async (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "tester"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  return { orch, events, prompts };
}

test("执行角色失败后交回项目经理重新决策，任务最终正常结算", async () => {
  const file = "runtime/tasks.failure-recovery.test.json";
  _resetForTest(file);
  const { orch, events, prompts } = failureRecoverySetup({ failTimes: 1 });
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", rootKey: "m-fr", messageId: "m-fr" });
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: { agentKey: "project_manager", summary: "派发", next: "", artifactPaths: [], assignments: [{ agentKey: "tester", task: "测试" }] },
      context: { chatId: "desktop-local", channel: "desktop" },
    });
    await orch.whenIdle();
    const failed = events.find((event) => event.type === "dispatch_failed");
    assert.equal(failed.recoverable, true);
    assert.ok(events.some((event) => event.type === "failure_handed_to_pm" && event.failed_agent === "tester" && event.attempt === 1));
    assert.ok(prompts.some((prompt) => prompt.includes("tester 执行失败")), "PM 的提示词应包含失败原因");
    assert.ok(events.some((event) => event.type === "task_settle" && event.task_id === task.taskId));
  } finally {
    rmSync(file, { force: true });
  }
});

test("失败恢复次数用尽后不再交回项目经理，dispatch_failed 变为终态失败", async () => {
  const file = "runtime/tasks.failure-recovery-limit.test.json";
  _resetForTest(file);
  const { orch, events } = failureRecoverySetup({ failTimes: 99 });
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", rootKey: "m-fr2", messageId: "m-fr2" });
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: { agentKey: "project_manager", summary: "派发", next: "", artifactPaths: [], assignments: [{ agentKey: "tester", task: "测试" }] },
      context: { chatId: "desktop-local", channel: "desktop" },
    });
    await orch.whenIdle();
    const handed = events.filter((event) => event.type === "failure_handed_to_pm");
    assert.equal(handed.length, 2, "默认最多交回 2 次");
    const failures = events.filter((event) => event.type === "dispatch_failed");
    assert.equal(failures.at(-1).recoverable, false);
  } finally {
    rmSync(file, { force: true });
  }
});

test("手动重试：失败的任务交回项目经理重新决策并重新结算；非失败任务不重试", async () => {
  const { TaskStore } = await import("../src/domain/task-store.js");
  const { configureTaskStore } = await import("../src/tasks.js");
  const dir = await mkdtemp(join(tmpdir(), "retry-"));
  const store = new TaskStore(join(dir, "t.json"));
  configureTaskStore(store);
  try {
    await store.create({ task_id: "RT", agent: "project_manager", source_chat_id: "desktop-local", project_name: "demo" });
    const prompts = [];
    const orch = createOrchestrator({
      runAgent: async (agent, prompt) => {
        prompts.push(prompt);
        return { text: "ok", delivery: { agentKey: agent.key, summary: "已重新处理", artifactPaths: [], final: true } };
      },
      onEvent: async (event) => { await store.applyEvent(event); },
      log: { info() {}, warn() {}, error() {} },
    });
    orch.registerRole({ key: "project_manager", displayName: "PM", appId: "x" }, {});

    await store.applyEvent({ type: "task_started", task_id: "RT" });
    assert.equal((await orch.retryTask("RT")).retried, false, "执行中的任务不能重试");

    await store.applyEvent({ type: "task_failed", task_id: "RT", error: "boom" });
    assert.equal((await store.getStatus("RT")).status, "failed");
    assert.deepEqual(await orch.retryTask("RT", { error: "ignored" }), { retried: true, attempt: 1 });
    await orch.whenIdle();

    assert.ok(prompts[0].includes("用户要求重试") && prompts[0].includes("boom"), "提示词带上快照里的失败原因");
    assert.equal((await store.getStatus("RT")).status, "completed");
    assert.equal(await orch.retryTask("NOPE"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function guardHarness(respond) {
  const runs = [];
  const events = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orch = createOrchestrator({
    runAgent: async (agent, prompt) => {
      runs.push({ key: agent.key, prompt });
      return respond(agent.key, runs.filter((run) => run.key === agent.key).length, prompt);
    },
    onEvent: async (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  });
  for (const key of ["project_manager", "frontend_developer", "tester", "auditor"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  return { orch, runs, events };
}
const desktopContext = { chatId: "desktop-local", channel: "desktop", requireHumanApproval: false };

test("派发守卫：项目经理只在文字里说已派发时，先纠正一次，纠正后按 assignments 真正派发", async () => {
  const { orch, runs, events } = guardHarness((key, _count, prompt) => key !== "project_manager"
    ? { text: "ok", delivery: { agentKey: key, summary: `${key} 完成`, artifactPaths: [], final: true } }
    : /最终汇总/.test(prompt)
      ? { text: "ok", delivery: { agentKey: key, summary: "全部完成", artifactPaths: [], final: true } }
      : { text: "ok", delivery: { agentKey: key, summary: "重新派发", assignments: [{ agentKey: "frontend_developer", task: "实现登录页" }], artifactPaths: [] } });
  await orch.onTaskCompleted("project_manager", "T-verbal", { delivery: { agentKey: "project_manager", summary: "已派发给前端开发实现登录页", artifactPaths: [] }, context: desktopContext });
  await orch.whenIdle();
  assert.deepEqual(runs.map((run) => run.key), ["project_manager", "frontend_developer", "project_manager"]);
  assert.match(runs[0].prompt, /【派发纠正】/);
  assert.match(runs[0].prompt, /frontend_developer/);
  assert.ok(events.some((event) => event.type === "dispatch_correction" && event.reason === "verbal_claim"));
});

test("派发守卫：纠正后仍只在文字里派发时，按点名的角色兜底派发", async () => {
  const { orch, runs, events } = guardHarness((key, _count, prompt) => key !== "project_manager"
    ? { text: "ok", delivery: { agentKey: key, summary: `${key} 完成`, artifactPaths: [], final: true, ...(key === "tester" ? { acceptance: PASSED_ACCEPTANCE } : {}) } }
    : /最终汇总/.test(prompt)
      ? { text: "ok", delivery: { agentKey: key, summary: "全部完成", artifactPaths: [], final: true } }
      : { text: "ok", delivery: { agentKey: key, summary: "已交给测试验证登录流程", artifactPaths: [] } });
  await orch.onTaskCompleted("project_manager", "T-fallback", { delivery: { agentKey: "project_manager", summary: "已交给测试验证", artifactPaths: [] }, context: desktopContext });
  await orch.whenIdle();
  assert.deepEqual(runs.map((run) => run.key), ["project_manager", "tester", "project_manager"]);
  const fallback = events.find((event) => event.type === "dispatch_fallback");
  assert.deepEqual(fallback?.targets, ["tester"]);
  assert.match(runs[1].prompt, /验证登录流程/);
});

test("派发守卫：兜底也推断不出派发对象时把任务判为失败，等待人工重试", async () => {
  const { orch, runs, events } = guardHarness(() => ({ text: "ok", delivery: { agentKey: "project_manager", summary: "已安排相关同事跟进", artifactPaths: [] } }));
  await orch.onTaskCompleted("project_manager", "T-unresolved", { delivery: { agentKey: "project_manager", summary: "已安排相关同事跟进", artifactPaths: [] }, context: desktopContext });
  await orch.whenIdle();
  assert.deepEqual(runs.map((run) => run.key), ["project_manager"]);
  assert.ok(events.some((event) => event.type === "task_failed" && event.task_id === "T-unresolved" && /无法确定派发对象/.test(event.error)));
});

test("验收门禁：测试结论为 fail 时不再推进到审计，交回项目经理决定打回修复", async () => {
  const file = "runtime/tasks.acceptance-fail.test.json";
  _resetForTest(file);
  const { orch, runs, events } = guardHarness((key) => ({ text: "ok", delivery: { agentKey: key, summary: "已安排前端修复", artifactPaths: [], final: true } }));
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "chat-acc", rootKey: "m-acc", messageId: "m-acc" });
    const acceptance = { verdict: "fail", summary: "登录失败", checks: [{ id: "AC2", title: "错误密码提示", status: "fail", detail: "返回 500" }], evidence: [{ kind: "command", text: "curl → 500" }] };
    await orch.onTaskCompleted("tester", `${task.taskId}:tester`, { delivery: { agentKey: "tester", summary: "验收未通过", artifactPaths: [], acceptance }, parentTaskId: task.taskId, context: { chatId: "chat-acc" } });
    await orch.whenIdle();
    assert.deepEqual(runs.map((run) => run.key), ["project_manager"], "审计不应在验收失败后被派发");
    assert.match(runs[0].prompt, /【验收未通过】/);
    assert.match(runs[0].prompt, /AC2 错误密码提示：返回 500/);
    const submitted = events.find((event) => event.type === "acceptance_submitted");
    assert.equal(submitted?.verdict, "fail");
    assert.deepEqual(submitted.failed_checks, ["错误密码提示"]);
    assert.ok(events.some((event) => event.type === "acceptance_failed_handed_to_pm"));
  } finally {
    rmSync(file, { force: true });
  }
});

test("验收门禁：测试未提交验收结果时重派一次补交，补交通过后正常推进", async () => {
  const file = "runtime/tasks.acceptance-missing.test.json";
  _resetForTest(file);
  const { orch, runs, events } = guardHarness((key) => key === "tester"
    ? { text: "ok", delivery: { agentKey: key, summary: "补交验收", artifactPaths: [], final: true, acceptance: PASSED_ACCEPTANCE } }
    : { text: "ok", delivery: { agentKey: key, summary: `${key} 完成`, artifactPaths: [], final: true } });
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "chat-miss", rootKey: "m-miss", messageId: "m-miss" });
    await orch.onTaskCompleted("tester", `${task.taskId}:tester`, { delivery: { agentKey: "tester", summary: "测过了，没问题", artifactPaths: [], final: true }, parentTaskId: task.taskId, context: { chatId: "chat-miss" } });
    await orch.whenIdle();
    assert.equal(runs[0].key, "tester");
    assert.match(runs[0].prompt, /【验收纠正】/);
    assert.ok(events.some((event) => event.type === "acceptance_correction"));
    assert.ok(events.some((event) => event.type === "acceptance_submitted" && event.verdict === "pass"));
    assert.equal(runs.at(-1).key, "project_manager", "验收通过后仍回到项目经理汇总");
  } finally {
    rmSync(file, { force: true });
  }
});

test("派发守卫：飞书需人工确认的上下文里，兜底派发直接执行，不登记无法点击的待确认", async () => {
  const { orch, runs } = guardHarness((key, _count, prompt) => key !== "project_manager"
    ? { text: "ok", delivery: { agentKey: key, summary: `${key} 完成`, artifactPaths: [], final: true, acceptance: PASSED_ACCEPTANCE } }
    : /最终汇总/.test(prompt)
      ? { text: "ok", delivery: { agentKey: key, summary: "全部完成", artifactPaths: [], final: true } }
      : { text: "ok", delivery: { agentKey: key, summary: "已交给测试验证", artifactPaths: [] } });
  await orch.onTaskCompleted("project_manager", "T-feishu-fallback", { delivery: { agentKey: "project_manager", summary: "已交给测试验证", artifactPaths: [] }, context: { chatId: "feishu-chat", requireHumanApproval: true } });
  await orch.whenIdle();
  assert.deepEqual(runs.map((run) => run.key), ["project_manager", "tester", "project_manager"]);
  assert.equal(await orch.resolveLatest("feishu-chat", "approve"), null, "不应留下待确认项");
});
