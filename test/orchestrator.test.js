import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createOrchestrator, matchRoutes } from "../src/orchestrator.js";
import { _resetForTest, createTask, setPaused } from "../src/tasks.js";

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

