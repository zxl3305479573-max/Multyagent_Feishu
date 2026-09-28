import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createOrchestrator, matchRoutes } from "../src/orchestrator.js";
import { buildResultCard } from "../src/gateway.js";
import { artifactsDirFor } from "../src/artifacts.js";
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
  assert.deepEqual(dispatched, ["architect"]);
  assert.equal(await orch.resumeTask(task.taskId), 0);
  await orch.whenIdle();
  assert.deepEqual(dispatched, ["architect"]);
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

test("确认集合内的非 PM/架构角色，卡片按钮同样能取到待确认项", async () => {
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
    delivery: { summary: "测试通过", next: "确认后继续执行", artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1", requireHumanApproval: true },
  });

  const resolved = await orch.resolveLatest("c1", "approve");
  assert.equal(resolved?.approved, true);
  assert.equal(resolved?.agentKey, "tester");
});

test("resolveLatest 按 task_id 精确解析同群待确认任务，旧卡片仍按最新项解析", async () => {
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const runAgent = async () => ({ text: "done", delivery: { summary: "done", final: true }, projectName: null });
  const log = { info() {}, error() {}, warn() {} };
  const orch = createOrchestrator({ runAgent, log });
  orch.registerRole({ key: "architect", displayName: "架构设计师", appId: "x" }, client);
  orch.registerRole({ key: "tester", displayName: "测试", appId: "x" }, client);
  const context = { chatId: "same-chat", requireHumanApproval: true };
  await orch.onTaskCompleted("architect", "task-old", { delivery: { summary: "old", next: "确认后继续执行" }, context });
  await orch.onTaskCompleted("tester", "task-new", { delivery: { summary: "new", next: "确认后继续执行" }, context });

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

test("PM 交付只有 next 时，确认后按下一步重新执行", async () => {
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

  const resolved = await orch.resolveLatest("c1", "approve");
  assert.equal(resolved?.approved, true, "卡片既然出按钮，点击就不能落空");
  await orch.whenIdle();
  assert.deepEqual(runs, ["project_manager"], "确认 next 后应重新运行项目经理");
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

  assert.equal(runs.length, 1);
  assert.equal(runs[0].key, "architect");
  assert.equal(runs[0].context.projectName, "student", "下游必须继承上游交付的项目名，否则写入白名单会解析成 default");
  assert.equal(runs[0].context.artifactsDir, artifactsDirFor("T-proj", "student"));
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

  assert.equal(runs.length, 1);
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
    assert.deepEqual(dispatched, ["architect"], "恢复后应正常放行下游");
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
