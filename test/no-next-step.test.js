import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { buildResultCard } from "../src/gateway.js";
import { createOrchestrator } from "../src/orchestrator.js";

function actionElement(card) {
  return card.body.elements.find((element) => element?.tag === "action");
}

test("没有下一步的非最终测试交付不显示确认按钮", () => {
  const card = buildResultCard({
    delivery: {
      agentKey: "tester",
      agentName: "测试",
      summary: "测试通过",
      artifactPaths: ["test-report.md"],
      final: false,
    },
  });

  assert.equal(actionElement(card), undefined);
  assert.match(card.header.title.content, /阶段完成/);
  assert.doesNotMatch(card.body.elements[0].text.content, /请确认后继续执行/);
});

test("没有下一步的交付不会登记待确认项", async () => {
  const events = [];
  const orchestrator = createOrchestrator({
    runAgent: async () => ({ text: "不应继续执行" }),
    log: { info() {}, warn() {}, error() {} },
    onEvent: async (event) => events.push(event),
  });
  await orchestrator.onTaskCompleted("terminal_role", "TASK-1", {
    delivery: { agentKey: "terminal_role", summary: "测试与审计已完成", artifactPaths: [], final: false },
    context: { chatId: "chat-1", requireHumanApproval: true },
  });

  assert.equal(await orchestrator.resolveLatest("chat-1", "approve"), null);
  assert.ok(events.some((event) => event.type === "task_settle" && event.reason === "no_next_step"));
});

test("重启时丢弃旧版本遗留的无下一步待确认项", async () => {
  const file = "runtime/no-next-step-approvals.test.json";
  writeFileSync(file, JSON.stringify({
    pending: {
      "chat-1:T-stale": {
        agentKey: "tester",
        taskId: "T-stale",
        delivery: { summary: "测试已完成", artifactPaths: [] },
        context: { chatId: "chat-1" },
        savedAt: Date.now(),
      },
    },
  }));
  try {
    const orchestrator = createOrchestrator({
      runAgent: async () => ({ text: "不应继续执行" }),
      approvalsFile: file,
      log: { info() {}, warn() {}, error() {} },
    });
    assert.equal(await orchestrator.resolveLatest("chat-1", "approve"), null);
  } finally {
    rmSync(file, { force: true });
  }
});

test("非 PM 的 next 自动交回项目经理决策，不出确认卡", async () => {
  const runs = [];
  const client = { im: { message: { create: async () => ({ code: 0 }) } } };
  const orchestrator = createOrchestrator({
    runAgent: async (agent) => {
      runs.push(agent.key);
      return { text: "完成", delivery: { agentKey: agent.key, summary: `${agent.key} 已完成`, artifactPaths: [], final: agent.key === "project_manager" } };
    },
    log: { info() {}, warn() {}, error() {} },
  });
  orchestrator.registerRole({ key: "tester", displayName: "测试", appId: "app" }, client);
  orchestrator.registerRole({ key: "auditor", displayName: "审计", appId: "app" }, client);
  orchestrator.registerRole({ key: "project_manager", displayName: "项目经理", appId: "app" }, client);

  await orchestrator.onTaskCompleted("tester", "TASK-next", {
    delivery: {
      agentKey: "tester",
      summary: "测试报告已完成",
      artifactPaths: ["test-report.md"],
      next: "派发审计，最后由项目经理汇总",
      final: false,
    },
    context: { chatId: "chat-next", requireHumanApproval: true },
  });

  assert.equal(await orchestrator.resolveLatest("chat-next", "approve"), null, "普通 next 不应登记待确认项");
  await orchestrator.whenIdle();
  assert.deepEqual(runs, ["project_manager"]);
});
