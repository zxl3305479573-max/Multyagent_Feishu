// Compatibility facade: TaskStore is the only durable source of task state.
import { TaskStore } from "./domain/task-store.js";

const DEFAULT_FILE = process.env.PI_DOMAIN_TASKS_FILE || process.env.PI_TASKS_FILE || "runtime/domain-tasks.json";
let store = new TaskStore(DEFAULT_FILE);

export function configureTaskStore(nextStore) {
  if (!nextStore || typeof nextStore.create !== "function") throw new TypeError("configureTaskStore requires a TaskStore-like object");
  store = nextStore;
  return store;
}

function legacy(task) {
  if (!task) return null;
  return {
    ...task,
    taskId: task.task_id,
    agentKey: task.agent,
    chatId: task.source_chat_id,
    rootKey: task.root_key || null,
    messageId: task.source_message_id,
    sessionFile: task.session_file || null,
    projectName: task.project_name || null,
    lastMessageId: task.last_message_id || null,
    updatedAt: task.updated_at ? Date.parse(task.updated_at) : null,
    createdAt: task.created_at ? Date.parse(task.created_at) : null,
  };
}

function domainPatch(patch = {}) {
  const result = { ...patch };
  const fields = { taskId: "task_id", agentKey: "agent", chatId: "source_chat_id", rootKey: "root_key", messageId: "source_message_id", sessionFile: "session_file", projectName: "project_name", lastMessageId: "last_message_id", parentTaskId: "parent_task_id" };
  for (const [legacyKey, domainKey] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(result, legacyKey)) { result[domainKey] = result[legacyKey]; delete result[legacyKey]; }
  }
  return result;
}

function rootOf(taskId) { return String(taskId || "").split(":")[0]; }

export async function createTask({ agentKey, chatId, rootKey, messageId, ...input } = {}) {
  const task = await store.create({ ...input, agent: agentKey || input.agent, requested_role: agentKey || input.requested_role || input.agent, source_chat_id: chatId || input.source_chat_id, source_message_id: messageId || input.source_message_id, root_key: rootKey || null, project_name: input.projectName || input.project_name || null, session_file: input.sessionFile || input.session_file || null });
  if (agentKey && rootKey) await store.linkAlias(agentKey, rootKey, task.task_id);
  if (agentKey && chatId) await store.setRecent(agentKey, chatId, task.task_id);
  return legacy(await store.get(task.task_id));
}

export async function updateTask(taskId, patch = {}) {
  const updated = await store.update(rootOf(taskId), domainPatch(patch));
  if (updated?.agent && updated.source_chat_id) await store.setRecent(updated.agent, updated.source_chat_id, updated.task_id);
  return legacy(updated);
}

export async function findTaskByRoot(agentKey, rootKey) { return legacy(await store.findByAlias(agentKey, rootKey)); }
export async function findRecentTask(agentKey, chatId, ttlMs) { return legacy(await store.findRecent(agentKey, chatId, ttlMs)); }
export async function linkRootAlias(agentKey, rootKey, taskId) { return legacy(await store.linkAlias(agentKey, rootKey, rootOf(taskId))); }
export async function setPaused(taskId, paused) { return legacy(await store.setPaused(rootOf(taskId), paused)); }
export async function isPaused(taskId) { return Boolean((await store.getRoot(taskId))?.paused); }
export async function setTerminated(taskId, terminated = true) { return legacy(await store.setTerminated(rootOf(taskId), terminated)); }
export async function isTerminated(taskId) { return Boolean((await store.getRoot(taskId))?.terminated); }

export function _resetForTest(newFile) { store = new TaskStore(newFile || DEFAULT_FILE); }
