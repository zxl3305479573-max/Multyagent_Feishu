import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/renderer/src/execution-view.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { groupToolExecutions, toolExecutionStatus, collectArtifacts, executionOwner, executionInstanceId, groupAgentExecutionInstances, groupExecutionInstancesByAgent, numberAgentInstances, agentStatus, executionTiming, latestPlanProgress, splitConversationTurns } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("conversation turns keep each user input before the execution it triggered", () => {
  const at = (seconds) => new Date(seconds * 1000).toISOString();
  const turns = splitConversationTurns([
    { type: "task_created", timestamp: at(1) },
    { type: "task_started", agent: "project_manager", timestamp: at(2) },
    { type: "task_completed", agent: "project_manager", timestamp: at(3) },
    { type: "task_reused", timestamp: at(4) },
    { type: "task_started", agent: "project_manager", timestamp: at(5) },
    { type: "task_completed", agent: "project_manager", timestamp: at(6) },
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.userEvent?.type), ["task_created", "task_reused"]);
  assert.deepEqual(turns.map((turn) => turn.events.map((event) => event.type)), [
    ["task_started", "task_completed"],
    ["task_started", "task_completed"],
  ]);
});

test("same-role child bots keep separate execution groups and receive stable instance numbers", () => {
  assert.equal(executionInstanceId({ type: "dispatch_started", task_id: "T:frontend_developer.a", sub_task_id: "T:frontend_developer.a" }), "T:frontend_developer.a");
  assert.equal(executionInstanceId({ type: "agent_started", task_id: "T:frontend_developer.b" }), "T:frontend_developer.b");

  const groups = groupAgentExecutionInstances([
    { type: "dispatch_started", target: "frontend_developer", task_id: "T:frontend_developer.a", timestamp: "2026-01-01T00:00:01Z" },
    { type: "agent_started", agent: "frontend_developer", task_id: "T:frontend_developer.a", timestamp: "2026-01-01T00:00:02Z" },
    { type: "dispatch_started", target: "frontend_developer", task_id: "T:frontend_developer.b", timestamp: "2026-01-01T00:00:03Z" },
    { type: "agent_started", agent: "backend_developer", task_id: "T:backend_developer", timestamp: "2026-01-01T00:00:04Z" },
  ]);
  assert.deepEqual(groups.map((group) => [group.agentKey, group.executionId, group.events.length]), [
    ["frontend_developer", "T:frontend_developer.a", 2],
    ["frontend_developer", "T:frontend_developer.b", 1],
    ["backend_developer", "T:backend_developer", 1],
  ]);

  const numbered = numberAgentInstances(groups.map((group) => ({ ...group, displayName: group.agentKey === "frontend_developer" ? "前端开发" : "后端开发" })));
  assert.deepEqual(numbered.map((group) => group.displayName), ["1号前端开发", "2号前端开发", "后端开发"]);

  const continued = numberAgentInstances([
    ...numbered,
    { ...groups[0], displayName: "前端开发" },
    { ...groups[1], displayName: "前端开发" },
  ]);
  assert.deepEqual(continued.slice(-2).map((group) => group.displayName), ["1号前端开发", "2号前端开发"], "继续执行同一个子机器人时沿用原编号");
});

test("six role bots stay independent and task slices stay with their own role", () => {
  const groups = groupAgentExecutionInstances([
    { type: "agent_started", agent: "project_manager", task_id: "T", timestamp: "2026-01-01T00:00:01Z" },
    { type: "dispatch_started", from: "project_manager", target: "frontend_developer", parent_task_id: "T", task_id: "T:frontend_developer", timestamp: "2026-01-01T00:00:02Z" },
    { type: "agent_started", agent: "frontend_developer", task_id: "T:frontend_developer", timestamp: "2026-01-01T00:00:03Z" },
    { type: "dispatch_started", from: "project_manager", target: "backend_developer", parent_task_id: "T", task_id: "T:backend_developer", timestamp: "2026-01-01T00:00:04Z" },
    { type: "dispatch_started", from: "frontend_developer", target: "tester", parent_task_id: "T:frontend_developer", task_id: "T:frontend_developer:tester", timestamp: "2026-01-01T00:00:05Z" },
    { type: "dispatch_started", from: "project_manager", target: "frontend_developer", parent_task_id: "T", task_id: "T:frontend_developer.second", timestamp: "2026-01-01T00:00:06Z" },
  ]).map((group) => ({ ...group, displayName: group.agentKey }));
  const bundles = groupExecutionInstancesByAgent(groups);
  assert.deepEqual(bundles.map((bundle) => bundle.agentKey), ["project_manager", "frontend_developer", "backend_developer", "tester"]);
  assert.equal(bundles[0].instances.length, 1, "项目经理只包含自己的执行实例");
  assert.equal(bundles[0].displayName, "project_manager", "主角色名不编号");
  assert.equal(bundles[0].instances[0].displayName, "project_manager", "未分片时不生成 1 号子机器人");
  assert.deepEqual(bundles.map((bundle) => bundle.instances.length), [1, 2, 1, 1]);
  assert.deepEqual(bundles[1].instances.map((group) => group.displayName), ["1号frontend_developer", "2号frontend_developer"]);
  assert.ok(bundles[1].instances.every((group) => group.agentKey === "frontend_developer"), "前端分块只归前端主机器人");
});

test("overlapping identical tools pair by call ID across intervening lifecycle events", () => {
  const events = [
    { type: "tool_call", tool: "bash", tool_call_id: "a", task_id: "T:tester" },
    { type: "tool_call", tool: "bash", tool_call_id: "b", task_id: "T:tester" },
    { type: "agent_started", task_id: "T:tester" },
    { type: "tool_result", tool: "bash", tool_call_id: "b", task_id: "T:tester", status: "failed" },
    { type: "tool_result", tool: "bash", tool_call_id: "a", task_id: "T:tester", status: "completed" },
    { type: "test_result", tool: "bash", tool_call_id: "a", task_id: "T:tester", status: "passed" },
  ];
  const tools = groupToolExecutions(events).filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].execution.events.map((event) => event.tool_call_id), ["a", "a", "a"]);
  assert.equal(toolExecutionStatus(tools[0].execution.events), "completed");
  assert.equal(toolExecutionStatus(tools[1].execution.events), "failed");
});

test("partial artifact descriptions preserve every path and normalize duplicate separators", () => {
  const items = collectArtifacts({ artifact_paths: ["artifacts/a.md", "artifacts\\b.md"], artifact_items: [{ path: "artifacts/b.md", description: "验收结果" }] });
  assert.equal(items.length, 2);
  assert.equal(items[1].description, "验收结果");
});

test("dispatch belongs to its target; late tools and non-final deliveries do not revive settled agents", () => {
  assert.equal(executionOwner({ type: "dispatch_started", from: "project_manager", target: "tester" }), "tester");
  assert.equal(agentStatus([{ type: "agent_started" }, { type: "agent_finished" }, { type: "tool_call" }, { type: "delivery_received", final: false }]), "completed");
  assert.equal(agentStatus([{ type: "agent_started" }, { type: "tool_call" }], "cancelled"), "cancelled");
  assert.equal(agentStatus([] , "completed"), "waiting");
  assert.equal(agentStatus([{ type: "dispatch_failed" }, { type: "tool_result", status: "completed" }]), "failed");
});

test("duration sums agent rounds without counting idle coordination time", () => {
  const at = (seconds) => new Date(seconds * 1000).toISOString();
  const result = executionTiming([
    { type: "agent_started", timestamp: at(1) }, { type: "agent_finished", timestamp: at(3) },
    { type: "agent_started", timestamp: at(20) }, { type: "agent_finished", timestamp: at(23) },
  ], 100000);
  assert.equal(result.durationMs, 5000);
  assert.equal(executionTiming([{ type: "agent_started", timestamp: at(1) }], 100000, at(4)).durationMs, 3000);
});

test("切片进度取最新快照；计划放弃或只有一项时不显示，快照不进对话时间线", () => {
  const slices = (statuses) => statuses.map((status, index) => ({ id: `s${index}`, agent: "frontend_developer", title: `切片 ${index}`, status }));
  const events = [
    { type: "plan_progress", task_id: "T", slices: slices(["running", "pending", "pending"]) },
    { type: "dispatch_started", task_id: "T:frontend_developer.s0", target: "frontend_developer" },
    { type: "plan_progress", task_id: "T", slices: slices(["completed", "running", "failed"]) },
  ];
  assert.deepEqual(
    (({ total, completed, running, failed }) => ({ total, completed, running, failed }))(latestPlanProgress(events)),
    { total: 3, completed: 1, running: 1, failed: 1 },
  );
  assert.equal(latestPlanProgress([...events, { type: "plan_progress", task_id: "T", cleared: true, slices: [] }]), null);
  assert.equal(latestPlanProgress([{ type: "plan_progress", task_id: "T", slices: slices(["running"]) }]), null);
  assert.equal(latestPlanProgress([]), null);
  assert.deepEqual(groupToolExecutions(events).map((item) => item.event.type), ["dispatch_started"]);
});
