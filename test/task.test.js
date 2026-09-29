import test from "node:test";
import assert from "node:assert/strict";
import { createTaskRecord } from "../src/domain/task.js";

test("新任务默认编号使用可读的日期时间格式", () => {
  const taskId = createTaskRecord().task_id;

  assert.match(taskId, /^TASK-\d{8}-\d{6}-[A-Z0-9]{6}$/);
});

test("显式传入的任务编号保持不变", () => {
  assert.equal(createTaskRecord({ task_id: "legacy-task-1" }).task_id, "legacy-task-1");
});
