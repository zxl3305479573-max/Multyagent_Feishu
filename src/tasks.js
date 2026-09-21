// 任务表：task_id ↔ session 文件映射 + 状态流转。
// 内存缓存 + 持久化到 runtime/tasks.json（可用 PI_TASKS_FILE 覆盖，测试用）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_FILE = "runtime/tasks.json";
let file = process.env.PI_TASKS_FILE || DEFAULT_FILE;
let state = { tasks: {}, byRoot: {}, recent: {} };
let loaded = false;
let writeChain = Promise.resolve();

async function load() {
  if (loaded) return;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch {
    state = { tasks: {}, byRoot: {}, recent: {} };
  }
  if (!state.tasks) state.tasks = {};
  if (!state.byRoot) state.byRoot = {};
  if (!state.recent) state.recent = {};
  loaded = true;
}

async function persist() {
  writeChain = writeChain.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2));
  });
  await writeChain;
}

// 按话题根（rootKey）查找任务，用于多轮追问复用。
export async function findTaskByRoot(agentKey, rootKey) {
  await load();
  if (!rootKey) return null;
  const taskId = state.byRoot[`${agentKey}:${rootKey}`];
  return taskId ? state.tasks[taskId] : null;
}

export async function createTask({ agentKey, chatId, rootKey, messageId }) {
  await load();
  const taskId = randomUUID();
  const task = {
    taskId,
    agentKey,
    chatId,
    rootKey: rootKey || null,
    firstMessageId: messageId,
    sessionFile: null,
    projectName: null,
    status: "received",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.tasks[taskId] = task;
  if (rootKey) state.byRoot[`${agentKey}:${rootKey}`] = taskId;
  touchRecent(task);
  await persist();
  return task;
}

export async function updateTask(taskId, patch) {
  await load();
  const task = state.tasks[taskId];
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: Date.now() });
  touchRecent(task);
  await persist();
  return task;
}

// 记录“同一群 + 同一机器人”的最近任务，用于无线程消息的会话延续。
function touchRecent(task) {
  state.recent[`${task.agentKey}:${task.chatId}`] = task.taskId;
}

// 查找同一群内该机器人时间窗口内的最近任务（无 root 关联时兜底）。
export async function findRecentTask(agentKey, chatId, ttlMs) {
  await load();
  const taskId = state.recent[`${agentKey}:${chatId}`];
  const task = taskId ? state.tasks[taskId] : null;
  if (!task) return null;
  if (ttlMs && Date.now() - task.updatedAt > ttlMs) return null;
  return task;
}

// 把额外的关联键（如机器人回复的消息 id）映射到已有任务，支持“回复某条消息”式追问。
export async function linkRootAlias(agentKey, rootKey, taskId) {
  await load();
  if (!rootKey || !taskId) return;
  state.byRoot[`${agentKey}:${rootKey}`] = taskId;
  await persist();
}

// 暂停/恢复任务：暂停后编排层不再派发下游。
export async function setPaused(taskId, paused) {
  await load();
  const task = state.tasks[taskId];
  if (!task) return null;
  task.paused = !!paused;
  task.updatedAt = Date.now();
  touchRecent(task);
  await persist();
  return task;
}

export async function isPaused(taskId) {
  await load();
  return !!state.tasks[taskId]?.paused;
}

// 测试钩子：重置内存状态并指向临时文件。
export function _resetForTest(newFile) {
  file = newFile || DEFAULT_FILE;
  state = { tasks: {}, byRoot: {}, recent: {} };
  loaded = false;
  writeChain = Promise.resolve();
}
