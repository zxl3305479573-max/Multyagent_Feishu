import test from "node:test";
import assert from "node:assert/strict";
import { aggregateChildDeliveries, finalizeProjectManagerDelivery, formatChildDeliverySummary } from "../src/orchestrator/final-summary.js";
import { createOrchestrator } from "../src/orchestrator.js";

const history = [
  { taskId: "T-1:frontend.fe-login", agentKey: "frontend_developer", agentName: "1号前端开发", assignmentId: "fe-login", summary: "登录页完成", artifactPaths: ["workspace/demo/artifacts/login.tsx"], artifactItems: [{ path: "workspace/demo/artifacts/login.tsx", description: "登录页面" }] },
  { taskId: "T-1:frontend.fe-list", agentKey: "frontend_developer", agentName: "2号前端开发", assignmentId: "fe-list", summary: "列表页完成", artifactPaths: ["workspace/demo/artifacts/list.tsx", "workspace/demo/artifacts/login.tsx"], blockers: ["等待接口联调"] },
  { taskId: "T-1:backend", agentKey: "backend_developer", agentName: "后端开发", summary: "接口完成", artifactPaths: ["workspace/demo/artifacts/api.json"] },
  { taskId: "T-1:tester", agentKey: "tester", agentName: "测试", summary: "验收通过", artifactPaths: [], acceptance: { verdict: "pass" } },
  { taskId: "T-1", agentKey: "project_manager", agentName: "项目经理", summary: "初始规划" },
];

test("子机器人交付按角色与文件去重统计", () => {
  const aggregate = aggregateChildDeliveries(history);
  assert.equal(aggregate.deliveryCount, 4);
  assert.equal(aggregate.agentCount, 3);
  assert.deepEqual(aggregate.artifactPaths, [
    "workspace/demo/artifacts/login.tsx",
    "workspace/demo/artifacts/list.tsx",
    "workspace/demo/artifacts/api.json",
  ]);
  assert.equal(aggregate.acceptanceCount, 1);
  assert.equal(aggregate.acceptancePassed, 1);
  assert.deepEqual(aggregate.blockers, ["等待接口联调"]);
  assert.match(formatChildDeliverySummary(aggregate), /子机器人交付：4 项/);
  assert.match(formatChildDeliverySummary(aggregate), /交付文件：3 个/);
});

test("项目经理最终交付自动合并子任务文件并追加总统计", () => {
  const { delivery, aggregate } = finalizeProjectManagerDelivery({
    summary: "全部任务已完成。",
    artifactPaths: ["workspace/demo/artifacts/final.md"],
    artifactItems: [{ path: "workspace/demo/artifacts/final.md", description: "最终总结" }],
    final: true,
  }, history);
  assert.equal(aggregate.deliveryCount, 4);
  assert.deepEqual(delivery.artifactPaths, [
    "workspace/demo/artifacts/login.tsx",
    "workspace/demo/artifacts/list.tsx",
    "workspace/demo/artifacts/api.json",
    "workspace/demo/artifacts/final.md",
  ]);
  assert.equal(delivery.artifactItems.find((item) => item.path.endsWith("login.tsx"))?.description, "登录页面");
  assert.match(delivery.summary, /全部任务已完成/);
  assert.match(delivery.summary, /执行汇总（系统统计）/);
  assert.match(delivery.summary, /覆盖角色：3 个/);
  assert.match(delivery.summary, /结构化验收：1 项，通过 1 项/);
  assert.match(delivery.summary, /1号前端开发（fe-login）：登录页完成/);
  assert.match(delivery.summary, /后端开发：接口完成/);
});

test("根任务结算后单独输出一次项目经理最终总结", async () => {
  const events = [];
  const orch = createOrchestrator({
    log: { info() {}, warn() {}, error() {} },
    onEvent: async (event) => events.push(event),
  });
  orch.registerRole({ key: "project_manager", displayName: "项目经理", appId: "x" }, { im: { message: { create: async () => ({ code: 0 }) } } });
  await orch.onTaskCompleted("project_manager", "T-final-output", {
    delivery: { summary: "全部任务已经完成。", artifactPaths: ["workspace/demo/artifacts/final.md"], final: true },
    context: { channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  const summaryEvents = events.filter((event) => event.type === "final_summary");
  assert.equal(summaryEvents.length, 1);
  assert.equal(summaryEvents[0].task_id, "T-final-output");
  assert.equal(summaryEvents[0].agent, "project_manager");
  assert.equal(summaryEvents[0].summary, "全部任务已经完成。");
  assert.deepEqual(summaryEvents[0].artifact_paths, ["workspace/demo/artifacts/final.md"]);
  const types = events.map((event) => event.type);
  assert.ok(types.lastIndexOf("final_summary") > types.lastIndexOf("task_settle"));
});

test("项目经理最终交付可追加由质量报告生成的结构化结论", () => {
  const { delivery } = finalizeProjectManagerDelivery({
    summary: "自由文本结论。",
    artifactPaths: [],
    final: true,
  }, history, {
    qualitySummary: "质量门禁（系统统计）：\n- AC：通过 2，失败 0，未覆盖 0\n- 上线结论：可以上线",
    qualityArtifacts: [
      { path: "workspace/demo/artifacts/T-1/quality-report.md", description: "质量报告" },
      { path: "workspace/demo/artifacts/T-1/quality-report.json", description: "质量数据" },
    ],
  });
  assert.match(delivery.summary, /自由文本结论/);
  assert.match(delivery.summary, /AC：通过 2/);
  assert.match(delivery.summary, /上线结论：可以上线/);
  assert.ok(delivery.artifactPaths.includes("workspace/demo/artifacts/T-1/quality-report.md"));
  assert.equal(delivery.artifactItems.find((item) => item.path.endsWith("quality-report.json"))?.description, "质量数据");
});
