import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLogger, projectTask, queryEvents } from "../src/observability.js";

test("event logger writes JSONL and task projection has table fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-events-"));
  const file = join(dir, "events.jsonl");
  await createEventLogger(file)({ type: "task_started", task_id: "T-1" });
  const line = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(line.type, "task_started");
  assert.equal(projectTask({ task_id: "T-1", status: "running", agent: "tester" }).owner_agent, "tester");
  await rm(dir, { recursive: true, force: true });
});

test("event logger adds run identity and monotonic sequence for correlating history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-events-run-"));
  const file = join(dir, "events.jsonl");
  const log = createEventLogger(file, { runId: "run-test-1", source: "test" });

  const first = await log({ type: "message_received", task_id: "task-1", chat_id: "chat-1" });
  const second = await log({ type: "task_started", task_id: "task-1", agent: "project_manager" });
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(first.run_id, "run-test-1");
  assert.equal(second.run_id, "run-test-1");
  assert.equal(first.source, "test");
  assert.equal(first.schema_version, 1);
  assert.equal(first.sequence + 1, second.sequence);
  assert.equal(first.pid, process.pid);
  assert.ok(first.timestamp);
  assert.equal(lines.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("event logger preserves causal links and duration metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-events-causal-"));
  const file = join(dir, "events.jsonl");
  const log = createEventLogger(file, { runId: "run-causal", source: "test" });
  const first = await log({ type: "dispatch_started", task_id: "T-1:backend", parent_task_id: "T-1", correlation_id: "corr-1" });
  const second = await log({ type: "test_result", task_id: "T-1:backend", parent_event_id: first.event_id, causation_id: first.event_id, duration_ms: 42, status: "passed" });
  assert.equal(second.parent_event_id, first.event_id);
  assert.equal(second.causation_id, first.event_id);
  assert.equal(second.duration_ms, 42);
  const result = await queryEvents(file, { taskId: "T-1" });
  assert.equal(result.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("event logger redacts commands and errors and excludes raw prompt/tool payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-events-safe-"));
  const file = join(dir, "events.jsonl");
  await createEventLogger(file)({
    type: "tool_call",
    command: "curl -H 'Authorization: Bearer secret-token-123' https://example.test?api_key=sk-secret-key",
    error: "password=hunter2",
    assigned_task: "use token=secret-token-123 to configure the API",
    prompt: "private prompt",
    thinking: "hidden reasoning",
    input: { content: "private tool input" },
    tool_output: "full output",
  });
  const line = JSON.parse((await readFile(file, "utf8")).trim());
  assert.doesNotMatch(line.command, /secret-token-123|sk-secret-key/);
  assert.doesNotMatch(line.error, /hunter2/);
  assert.doesNotMatch(line.assigned_task, /secret-token-123/);
  assert.equal("prompt" in line, false);
  assert.equal("thinking" in line, false);
  assert.equal("input" in line, false);
  assert.equal("tool_output" in line, false);
  await rm(dir, { recursive: true, force: true });
});
