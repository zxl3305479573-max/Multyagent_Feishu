import test from "node:test";
import assert from "node:assert/strict";
import { buildResultCard } from "../src/gateway.js";
import { createOrchestrator } from "../src/orchestrator.js";

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
  assert.deepEqual(dispatched, ["architect"]);
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
