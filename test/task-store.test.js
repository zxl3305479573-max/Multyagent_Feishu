import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { TaskStore } from "../src/domain/task-store.js";

const FILE = "runtime/domain-task-store.test.json";

test.afterEach(() => {
  rmSync(FILE, { force: true });
});

test("按幂等键创建任务并在重启后恢复", async () => {
  const first = new TaskStore(FILE);
  const task = await first.create({
    idempotency_key: "msg:om_1",
    agent: "frontend_developer",
    source_message_id: "om_1",
    source_chat_id: "oc_1",
    title: "修改登录页",
  });
  const duplicate = await first.create({
    idempotency_key: "msg:om_1",
    agent: "frontend_developer",
    source_message_id: "om_1",
    source_chat_id: "oc_1",
    title: "重复消息",
  });
  assert.equal(duplicate.task_id, task.task_id);

  const restarted = new TaskStore(FILE);
  const restored = await restarted.get(task.task_id);
  assert.equal(restored.title, "修改登录页");
  assert.equal(await restarted.count(), 1);
});

test("任务状态迁移拒绝非法跳转并持久化合法跳转", async () => {
  const store = new TaskStore(FILE);
  const task = await store.create({ idempotency_key: "msg:om_2", agent: "tester" });
  await assert.rejects(() => store.transition(task.task_id, "completed"), /非法任务状态迁移/);
  const updated = await store.transition(task.task_id, "classified");
  assert.equal(updated.status, "classified");
  assert.equal((await new TaskStore(FILE).get(task.task_id)).status, "classified");
});

test("租约防止并发领取并支持失败重试", async () => {
  const store = new TaskStore(FILE);
  const task = await store.create({ idempotency_key: "lease:1", max_attempts: 2 });
  assert.ok(await store.claim(task.task_id, { owner: "a", leaseMs: 60_000 }));
  assert.equal(await store.claim(task.task_id, { owner: "b", leaseMs: 60_000 }), null);
  await store.transition(task.task_id, "classified");
  await store.transition(task.task_id, "planned");
  await store.transition(task.task_id, "ready");
  await store.transition(task.task_id, "running");
  await store.transition(task.task_id, "failed");
  const retried = await store.retry(task.task_id, "boom");
  assert.equal(retried.status, "retrying");
  assert.equal(retried.attempt, 1);
});
