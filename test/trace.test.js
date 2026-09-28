import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTraceEvent, toTraceFields } from "../src/domain/trace.js";

test("trace keeps structured execution metadata but excludes prompts and model reasoning", () => {
  const event = sanitizeTraceEvent({
    event_id: "evt-1",
    timestamp: "2026-09-23T01:02:03.000Z",
    task_id: "T-1:backend",
    parent_task_id: "T-1",
    agent: "backend_developer",
    type: "tool_call",
    state: "running",
    tool: "bash",
    command: "npm test",
    prompt: "private prompt",
    text: "full user prompt",
    thinking: "hidden chain of thought",
    tool_output: "complete output",
    error: null,
  });
  assert.equal(event.event_id, "evt-1");
  assert.equal(event.command, "npm test");
  assert.equal("prompt" in event, false);
  assert.equal("text" in event, false);
  assert.equal("thinking" in event, false);
  assert.equal("tool_output" in event, false);
  assert.equal(toTraceFields(event)["任务编号"], "T-1");
  assert.equal(toTraceFields(event)["子任务编号"], "T-1:backend");
});

test("trace surfaces the structured task assigned to a downstream agent", () => {
  const event = sanitizeTraceEvent({ type: "dispatch_started", task_id: "T-1:backend", assigned_task: "Implement the API contract", prompt: "private generated prompt" });
  assert.equal(event.summary, "Implement the API contract");
  assert.equal(toTraceFields(event)["摘要"], "Implement the API contract");
  assert.equal("prompt" in event, false);
});

test("trace redacts common credentials from commands and errors", () => {
  const event = sanitizeTraceEvent({
    type: "tool_call",
    command: "curl -H 'Authorization: Bearer abc.def.ghi' https://example.test?api_key=sk-secret",
    error: "password=hunter2 token: xoxb-secret",
  });
  assert.doesNotMatch(event.command, /abc\.def\.ghi|sk-secret/);
  assert.doesNotMatch(event.error, /hunter2|xoxb-secret/);
  assert.match(event.command, /REDACTED/);
  assert.match(event.error, /REDACTED/);
});

test("trace projection only includes the explicit allowlisted fields", () => {
  const fields = toTraceFields({
    event_id: "evt-2",
    timestamp: "2026-09-23T01:02:03.000Z",
    task_id: "T-2",
    agent: "tester",
    type: "test_result",
    status: "failed",
    tool: "bash",
    command: "npm test",
    file_path: "test/a.test.js",
    summary: "1 failing test",
    error: "assertion failed",
    prompt: "must not leak",
  });
  assert.equal(fields["事件编号"], "evt-2");
  assert.equal(fields["命令"], "npm test");
  assert.equal("prompt" in fields, false);
  assert.equal(Object.keys(fields).includes("must not leak"), false);
});

test("trace keeps causal and execution evidence fields", () => {
  const event = sanitizeTraceEvent({
    event_id: "evt-3",
    task_id: "T-3:tester",
    parent_event_id: "evt-2",
    causation_id: "evt-2",
    attempt: 2,
    duration_ms: 1234,
    tool_name: "pytest",
    file_changes: ["src/a.js"],
    test_result: { passed: 3, failed: 0 },
  });
  assert.equal(event.parent_event_id, "evt-2");
  assert.equal(event.attempt, 2);
  assert.equal(event.duration_ms, 1234);
  assert.equal(event.tool_name, "pytest");
  assert.deepEqual(event.file_changes, ["src/a.js"]);
  assert.deepEqual(event.test_result, { passed: 3, failed: 0 });
});
