import test from "node:test";
import assert from "node:assert/strict";
import { buildValidatedHandoff } from "../src/domain/delivery.js";

test("buildValidatedHandoff 接受交付协议里的 agentKey", async () => {
  const handoff = await buildValidatedHandoff({
    agentKey: "project_manager",
    agentName: "项目经理",
    summary: "完成项目计划",
    artifactPaths: [],
    next: "派发架构设计师",
  }, { taskId: "T-agent", agentKey: "project_manager" });

  assert.equal(handoff.agent, "project_manager");
  assert.equal(handoff.task_id, "T-agent");
  assert.equal(handoff.next_action, "派发架构设计师");
});

test("buildValidatedHandoff 同时兼容显式 agent 参数", async () => {
  const handoff = await buildValidatedHandoff({
    summary: "复验通过",
    artifactPaths: [],
    next: "交给项目经理汇总",
  }, { taskId: "T-agent-2", agent: "tester" });

  assert.equal(handoff.agent, "tester");
});

test("next 为空时交接包仍有效（派发型交付不会因缺省 next 被判无效）", async () => {
  const dispatching = await buildValidatedHandoff({ summary: "派发", next: "", artifactPaths: [], final: false }, { agentKey: "project_manager", taskId: "T1" });
  assert.ok(dispatching.next_action);
  const finalOne = await buildValidatedHandoff({ summary: "完成", artifactPaths: [], final: true }, { agentKey: "project_manager", taskId: "T1" });
  assert.equal(finalOne.next_action, "无需后续操作");
});
