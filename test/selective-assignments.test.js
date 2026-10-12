import test from "node:test";
import assert from "node:assert/strict";
import { buildResultCard } from "../src/gateway.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { sequenceArchitectFirst } from "../src/orchestrator/assignments.js";

function setup() {
  const dispatched = [];
  const runAgent = async (agent) => {
    dispatched.push(agent.key);
    return { text: "done", delivery: { summary: "done", artifactPaths: [], artifactsDir: "d", final: true } };
  };
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const log = { info() {}, warn() {}, error() {} };
  const orchestrator = createOrchestrator({ runAgent, log });
  for (const key of ["project_manager", "architect", "frontend_developer", "backend_developer"]) {
    orchestrator.registerRole({ key, displayName: key, appId: "app" }, client);
  }
  return { orchestrator, dispatched };
}

test("project manager assignments filter downstream dispatch", async () => {
  const { orchestrator, dispatched } = setup();
  await orchestrator.onTaskCompleted("project_manager", "T-select", {
    delivery: {
      agentKey: "project_manager",
      summary: "plan",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [{ agentKey: "architect", task: "produce contract", reason: "required" }],
    },
    context: { chatId: "chat" },
  });
  assert.deepEqual(dispatched, ["architect", "project_manager"], "派发限定在 assignments 内，结束后回到项目经理汇总");
});

test("empty project manager assignments do not dispatch", async () => {
  const { orchestrator, dispatched } = setup();
  await orchestrator.onTaskCompleted("project_manager", "T-empty", {
    delivery: { agentKey: "project_manager", summary: "plan", artifactPaths: [], artifactsDir: "d", assignments: [] },
    context: { chatId: "chat" },
  });
  assert.deepEqual(dispatched, []);
});

test("result card renders assignment list", () => {
  const card = buildResultCard({ delivery: {
    agentKey: "project_manager",
    summary: "plan",
    assignments: [{ agentKey: "backend_developer", task: "implement API", reason: "server work" }],
  } });
  const content = card.body.elements.map((element) => element.text?.content || "").join("\n");
  assert.match(content, /任务分配/);
  // 卡片正文按设计只渲染任务文本，不含 agent key（角色体现在 assignments 结构里）
  assert.match(content, /implement API/);
  assert.match(content, /请确认后继续执行/);
  assert.match(card.header.title.content, /^\u8bf7\u786e\u8ba4\u4e0b\u4e00\u6b65/);
});

test("result card renders blockers and risks from the delivery protocol", () => {
  const card = buildResultCard({ delivery: {
    agentKey: "project_manager",
    summary: "plan needs a decision",
    blockers: ["waiting for product owner"],
    risks: ["scope may expand"],
  } });
  const content = card.body.elements.map((element) => element.text?.content || "").join("\n");
  assert.match(content, /阻塞/);
  assert.match(content, /waiting for product owner/);
  assert.match(content, /风险/);
  assert.match(content, /scope may expand/);
});

test("PM 同时派发架构设计师与开发角色时，架构先行、交付后再派发开发", async () => {
  const { orchestrator, dispatched } = setup();
  await orchestrator.onTaskCompleted("project_manager", "T-arch-first", {
    delivery: {
      agentKey: "project_manager",
      summary: "plan",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [
        { agentKey: "frontend_developer", task: "build UI", reason: "ui" },
        { agentKey: "architect", task: "produce architecture diagram", reason: "new system" },
        { agentKey: "backend_developer", task: "build API", reason: "api" },
      ],
    },
    context: { chatId: "chat" },
  });
  await orchestrator.whenIdle();
  // 架构设计师交付 final=true 也不能提前结算，后续阶段必须继续派发
  assert.equal(dispatched[0], "architect");
  assert.deepEqual(dispatched.slice(1, 3).sort(), ["backend_developer", "frontend_developer"]);
  assert.equal(dispatched.at(-1), "project_manager", "全部阶段完成后回到项目经理汇总");
  assert.equal(dispatched.length, 4);
});

test("PM 判断无需架构设计时不会自动插入架构设计师", async () => {
  const { orchestrator, dispatched } = setup();
  await orchestrator.onTaskCompleted("project_manager", "T-no-arch", {
    delivery: {
      agentKey: "project_manager",
      summary: "small fix",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [{ agentKey: "backend_developer", task: "fix one endpoint", reason: "existing architecture" }],
    },
    context: { chatId: "chat" },
  });
  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, ["backend_developer", "project_manager"]);
});

test("sequenceArchitectFirst 尊重 PM 显式提交的阶段计划", () => {
  const plan = { project: "demo", goal: "g", stages: [{ id: "s1", assignments: [{ id: "b", agentKey: "backend_developer", task: "x" }] }] };
  const delivery = { assignments: [{ agentKey: "architect", task: "a" }, { agentKey: "backend_developer", task: "b" }], plan };
  assert.equal(sequenceArchitectFirst(delivery), delivery);
  const sequenced = sequenceArchitectFirst({ summary: "s", assignments: [{ agentKey: "architect", task: "a" }, { agentKey: "tester", task: "t" }] });
  assert.deepEqual(sequenced.assignments.map((item) => item.agentKey), ["architect"]);
  assert.deepEqual(sequenced.plan.stages[1].assignments[0].dependsOn, ["architect"]);
});
