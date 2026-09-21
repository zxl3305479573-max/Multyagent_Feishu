import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATES,
  assertTransition,
  canTransition,
  isTerminal,
  transition,
} from "../src/domain/task-state.js";

test("允许任务按定义的主流程迁移", () => {
  assert.equal(canTransition("received", "classified"), true);
  assert.equal(transition("received", "classified"), "classified");
  assert.equal(transition("running", "succeeded"), "succeeded");
  assert.equal(transition("succeeded", "completed"), "completed");
});

test("非法状态迁移会抛错", () => {
  assert.throws(
    () => assertTransition("received", "completed"),
    /非法任务状态迁移/,
  );
});

test("终态不可继续迁移", () => {
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(canTransition("completed", "running"), false);
});

test("状态集合包含计划中的补充状态", () => {
  assert.deepEqual(
    TASK_STATES,
    [
      "received",
      "classified",
      "planned",
      "waiting_approval",
      "ready",
      "running",
      "blocked",
      "failed",
      "succeeded",
      "completed",
      "cancelled",
      "retrying",
      "waiting_dependency",
      "waiting_input",
    ],
  );
});
