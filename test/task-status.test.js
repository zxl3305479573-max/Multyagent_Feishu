import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTaskEvents } from "../src/task-status.js";

test("summarizeTaskEvents returns the current lifecycle of a root task and its subtasks", () => {
  const status = summarizeTaskEvents([
    { type: "task_started", task_id: "T-1", chat_id: "chat-1", project_name: "student" },
    { type: "dispatch_started", task_id: "T-1:architect", parent_task_id: "T-1", chat_id: "chat-1", target: "architect" },
    { type: "approval_required", task_id: "T-1:architect", parent_task_id: "T-1", chat_id: "chat-1", agent: "architect" },
  ], "T-1", "chat-1");

  assert.equal(status.task_id, "T-1");
  assert.equal(status.status, "awaiting_approval");
  assert.equal(status.project_name, "student");
  assert.deepEqual(status.active_agents, ["architect"]);
  assert.equal(status.latest_event, "approval_required");
});

test("summarizeTaskEvents excludes events from another chat", () => {
  const status = summarizeTaskEvents([
    { type: "task_failed", task_id: "T-1", chat_id: "chat-other", error: "secret failure" },
    { type: "task_completed", task_id: "T-1", chat_id: "chat-1", final: true },
  ], "T-1", "chat-1");

  assert.equal(status.status, "completed");
  assert.equal(status.error, null);
});

test("终态不会被迟到的 task_started 回退，且根 Agent 执行中可见", () => {
  const status = summarizeTaskEvents([
    { type: "task_started", task_id: "T-2", chat_id: "chat-2", agent: "project_manager", sequence: 1 },
    { type: "task_settle", task_id: "T-2", chat_id: "chat-2", reason: "final", sequence: 2 },
    { type: "task_started", task_id: "T-2", chat_id: "chat-2", agent: "project_manager", sequence: 3 },
  ], "T-2", "chat-2");

  assert.equal(status.status, "completed");
  assert.equal(status.latest_event, "task_settle");
  assert.deepEqual(status.active_agents, []);
});

test("根任务 task_started 在未结束时会标记根 Agent 活跃", () => {
  const status = summarizeTaskEvents([
    { type: "task_started", task_id: "T-3", chat_id: "chat-3", agent: "project_manager", sequence: 1 },
  ], "T-3", "chat-3");

  assert.equal(status.status, "in_progress");
  assert.deepEqual(status.active_agents, ["project_manager"]);
});
