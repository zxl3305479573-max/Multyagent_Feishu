import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { _resetForTest, createTask, findRecentTask, findTaskByRoot, isPaused, isTerminated, linkRootAlias, setPaused, setTerminated, updateTask } from "../src/tasks.js";
import { TaskStore } from "../src/domain/task-store.js";

const TEST_FILE = "runtime/tasks.test.json";

test.beforeEach(() => {
  _resetForTest(TEST_FILE);
});

test.afterEach(() => {
  rmSync(TEST_FILE, { force: true });
});

test("创建任务并可按 root 查询", async () => {
  const task = await createTask({ agentKey: "tester", chatId: "c1", rootKey: "m1", messageId: "m1" });
  assert.ok(task.taskId);
  assert.equal(task.status, "received");
  const found = await findTaskByRoot("tester", "m1");
  assert.equal(found.taskId, task.taskId);
});

test("不同 agent 或不同 root 不串", async () => {
  const t1 = await createTask({ agentKey: "a", chatId: "c1", rootKey: "r1", messageId: "m1" });
  await createTask({ agentKey: "b", chatId: "c1", rootKey: "r1", messageId: "m2" });
  assert.equal((await findTaskByRoot("a", "r1")).taskId, t1.taskId);
  assert.equal(await findTaskByRoot("a", "r2"), null);
});

test("无 rootKey 不建立索引", async () => {
  await createTask({ agentKey: "a", chatId: "c1", rootKey: null, messageId: "m1" });
  assert.equal(await findTaskByRoot("a", "m1"), null);
});

test("更新任务状态与 sessionFile", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "r1", messageId: "m1" });
  await updateTask(task.taskId, { status: "completed", sessionFile: "runtime/sessions/a/x.jsonl" });
  const found = await findTaskByRoot("a", "r1");
  assert.equal(found.status, "completed");
  assert.equal(found.sessionFile, "runtime/sessions/a/x.jsonl");
});

test("任务记录并更新 projectName", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "r1", messageId: "m1" });
  assert.equal(task.projectName, null);
  await updateTask(task.taskId, { projectName: "phone-login" });
  const found = await findTaskByRoot("a", "r1");
  assert.equal(found.projectName, "phone-login");
});

test("linkRootAlias：按机器人消息 id 关联追问", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "m1", messageId: "m1" });
  await linkRootAlias("a", "bot-msg-1", task.taskId);
  const found = await findTaskByRoot("a", "bot-msg-1");
  assert.equal(found.taskId, task.taskId);
});

test("findRecentTask：同群同机器人命中，其他不命中", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "m1", messageId: "m1" });
  assert.equal((await findRecentTask("a", "c1", 60000)).taskId, task.taskId);
  assert.equal(await findRecentTask("a", "c2", 60000), null); // 不同群
  assert.equal(await findRecentTask("b", "c1", 60000), null); // 不同机器人
});

test("setPaused / isPaused 控制任务暂停", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "m1", messageId: "m1" });
  assert.equal(await isPaused(task.taskId), false);
  await setPaused(task.taskId, true);
  assert.equal(await isPaused(task.taskId), true);
  await setPaused(task.taskId, false);
  assert.equal(await isPaused(task.taskId), false);
});

test("任务终止状态可持久化，恢复命令不能解除终止", async () => {
  const task = await createTask({ agentKey: "a", chatId: "c1", rootKey: "r-stop", messageId: "m-stop" });
  await setTerminated(task.taskId, true);
  assert.equal(await isTerminated(task.taskId), true);
  await setPaused(task.taskId, false);
  assert.equal(await isTerminated(task.taskId), true);
  _resetForTest(TEST_FILE);
  assert.equal(await isTerminated(task.taskId), true);
});

test("legacy task facade and TaskStore observe the same task", async () => {
  const task = await createTask({ agentKey: "backend_developer", chatId: "chat-1", rootKey: "thread-1", messageId: "m-1" });
  const record = await new TaskStore(TEST_FILE).get(task.taskId);
  assert.equal(record.agent, "backend_developer");
  assert.equal(record.source_chat_id, "chat-1");
});

test("pause and terminate are represented in the domain task record", async () => {
  const task = await createTask({ agentKey: "backend_developer", chatId: "chat-1", messageId: "m-1" });
  await setPaused(task.taskId, true);
  assert.equal((await new TaskStore(TEST_FILE).get(task.taskId)).paused, true);
  await setTerminated(task.taskId, true);
  const record = await new TaskStore(TEST_FILE).get(task.taskId);
  assert.equal(record.terminated, true);
  assert.equal(record.paused, false);
});
