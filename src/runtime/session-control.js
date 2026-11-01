const sessionsByTask = new Map();
const terminatedRoots = new Set();

function rootOf(taskId) {
  return String(taskId || "").split(":")[0];
}

export function registerActiveSession(taskId, session) {
  const root = rootOf(taskId);
  if (!root || !session?.abort) return () => {};
  if (terminatedRoots.has(root)) {
    void session.abort();
    return () => {};
  }
  const sessions = sessionsByTask.get(root) || new Set();
  sessions.add(session);
  sessionsByTask.set(root, sessions);
  return () => {
    sessions.delete(session);
    if (!sessions.size) sessionsByTask.delete(root);
  };
}

export async function abortActiveSessions(taskId) {
  const root = rootOf(taskId);
  if (!root) return 0;
  terminatedRoots.add(root);
  const sessions = [...(sessionsByTask.get(root) || [])];
  sessionsByTask.delete(root);
  await Promise.all(sessions.map(async (session) => {
    try { await session.abort(); }
    catch {
    }
  }));
  return sessions.length;
}

export function isSessionTaskTerminated(taskId) {
  return terminatedRoots.has(rootOf(taskId));
}

export function resetSessionControlForTest() {
  sessionsByTask.clear();
  terminatedRoots.clear();
}
