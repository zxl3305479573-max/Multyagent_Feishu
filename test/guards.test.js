import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerbalDispatch, inferDispatchTargets } from "../src/orchestrator/guards.js";
import { createDeliverTool, droppedAssignments } from "../src/agent/tools.js";

test("dispatch guard flags a PM that claims to have dispatched without assignments", () => {
  assert.equal(detectVerbalDispatch({ delivery: { summary: "已派发给前端开发实现登录页" } })?.reason, "verbal_claim");
  assert.equal(detectVerbalDispatch({ delivery: { summary: "方案已定", next: "交给测试验证" } })?.reason, "verbal_claim");
  assert.equal(detectVerbalDispatch({ delivery: { summary: "x" }, resultText: "我已经安排后端处理" })?.reason, "verbal_claim");
});

test("dispatch guard flags assignments that were all dropped as invalid", () => {
  const detection = detectVerbalDispatch({ delivery: { summary: "计划", assignments: [], droppedAssignments: [{ agentKey: "frontend", reason: "未知角色" }] } });
  assert.equal(detection?.reason, "dropped_assignments");
  assert.match(detection.detail, /frontend（未知角色）/);
});

test("dispatch guard leaves real dispatches, final summaries, choices and plain answers alone", () => {
  assert.equal(detectVerbalDispatch({ delivery: { summary: "已派发给前端", assignments: [{ agentKey: "frontend_developer", task: "x" }] } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "前端已交给测试验证完毕，全部完成", final: true } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "交给前端还是后端？", choices: [{ id: "a", label: "前端" }] } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "当前共有 3 个项目：one、test1、student2" } }), null);
});

test("fallback dispatch infers named roles that are registered, never the PM itself", () => {
  const keys = ["project_manager", "architect", "frontend_developer", "tester"];
  assert.deepEqual(inferDispatchTargets("已交给前端开发和测试", keys), ["frontend_developer", "tester"]);
  assert.deepEqual(inferDispatchTargets("交给后端处理", keys), [], "unregistered backend is ignored");
  assert.deepEqual(inferDispatchTargets("项目经理自己完成", keys), []);
});

test("droppedAssignments explains why each PM assignment was discarded", () => {
  const dropped = droppedAssignments([
    { agentKey: "frontend", task: "x" },
    { agentKey: "project_manager", task: "x" },
    { agentKey: "tester", task: "" },
    { agentKey: "architect", task: "design" },
    { agentKey: "architect", task: "again" },
  ], { selfAgentKey: "project_manager" });
  assert.deepEqual(dropped.map((item) => item.reason), ["未知角色", "不能派给自己", "缺少 task", "重复派发"]);
});

test("deliver_artifact records PM assignments that were dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-dropped-"));
  try {
    const delivered = [];
    const tool = createDeliverTool({ root, getArtifactsDir: () => root, getProjectName: () => null, agentKey: "project_manager", agentName: "PM", onDeliver: (delivery) => delivered.push(delivery) });
    await tool.execute("c1", { summary: "派发", assignments: [{ agentKey: "frontend", task: "做页面" }] });
    assert.deepEqual(delivered[0].assignments, []);
    assert.deepEqual(delivered[0].droppedAssignments, [{ agentKey: "frontend", reason: "未知角色" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
