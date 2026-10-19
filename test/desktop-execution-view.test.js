import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/renderer/src/execution-view.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { groupToolExecutions, toolExecutionStatus, collectArtifacts, executionOwner, agentStatus, executionTiming, latestPlanProgress } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

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
