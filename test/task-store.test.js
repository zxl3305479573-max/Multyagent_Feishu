import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { TaskStore } from "../src/domain/task-store.js";

const FILE = "runtime/domain-task-store.test.json";

test("event snapshots persist and do not regress after a terminal event", async () => {
  const store = new TaskStore(FILE);
  const task = await store.create({ agent: "project_manager", source_chat_id: "chat-snapshot" });
  await store.applyEvent({ type: "task_started", task_id: task.task_id, agent: "project_manager", chat_id: "chat-snapshot", timestamp: "2026-09-24T01:00:00.000Z" });
  await store.applyEvent({ type: "task_settle", task_id: task.task_id, chat_id: "chat-snapshot", timestamp: "2026-09-24T01:01:00.000Z" });
  await store.applyEvent({ type: "task_started", task_id: task.task_id, agent: "project_manager", chat_id: "chat-snapshot", timestamp: "2026-09-24T01:02:00.000Z" });
  const snapshot = await new TaskStore(FILE).getStatus(task.task_id, "chat-snapshot");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.latest_event, "task_settle");
  assert.deepEqual(snapshot.active_agents, []);
});

test("更新任务项目名时同步更新状态快照", async () => {
  const file = "runtime/task-store.project-name.test.json";
  rmSync(file, { force: true });
  try {
    const store = new TaskStore(file);
    await store.create({ task_id: "T-project", agent: "project_manager", source_chat_id: "chat-project" });
    await store.applyEvent({ type: "task_started", task_id: "T-project", timestamp: "2026-01-01T00:00:00.000Z" });
    await store.update("T-project", { project_name: "student" });
    const status = await store.getStatus("T-project", "chat-project");
    assert.equal(status.project_name, "student");
  } finally {
    rmSync(file, { force: true });
  }
});

test("迟到的旧开始事件不会覆盖任务已切换的项目", async () => {
  const file = "runtime/task-store.project-late.test.json";
  rmSync(file, { force: true });
  try {
    const store = new TaskStore(file);
    await store.create({ task_id: "T-project-late", agent: "project_manager", source_chat_id: "chat-project" });
    await store.applyEvent({ type: "task_started", task_id: "T-project-late", project_name: "default" });
    await store.applyEvent({ type: "delivery_received", task_id: "T-project-late", project_name: "student" });
    await store.update("T-project-late", { project_name: "student" });
    await store.applyEvent({ type: "task_started", task_id: "T-project-late", project_name: "default" });
    const status = await store.getStatus("T-project-late", "chat-project");
    assert.equal(status.project_name, "student");
  } finally {
    rmSync(file, { force: true });
  }
});

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

test("只把旧任务文件中缺失的记录迁移到统一 store", async () => {
  const legacy = "runtime/legacy-task-store.test.json";
  const target = "runtime/domain-task-migration.test.json";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(legacy, JSON.stringify({
    tasks: { "old-1": { taskId: "old-1", agentKey: "tester", chatId: "chat", rootKey: "root", status: "completed", createdAt: Date.now(), updatedAt: Date.now() } },
    byRoot: { "tester:root": "old-1" },
  }));
  const store = new TaskStore(target);
  assert.deepEqual(await store.migrateLegacyFile(legacy), { imported: 1 });
  assert.equal((await store.get("old-1")).agent, "tester");
  assert.equal((await store.findByAlias("tester", "root")).task_id, "old-1");
  assert.deepEqual(await store.migrateLegacyFile(legacy), { imported: 0 });
  rmSync(legacy, { force: true });
  rmSync(target, { force: true });
});
