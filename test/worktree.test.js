import test from "node:test";
import assert from "node:assert/strict";
import { worktreePath, listWorktrees } from "../src/runtime/worktree.js";

test("worktreePath keeps agent and task inside the managed workspace", () => {
  assert.match(worktreePath({ root: "D:/repo", agentKey: "frontend_developer", taskId: "T-001" }), /runtime[\\/]workspaces[\\/]frontend_developer[\\/]T-001$/);
  assert.throws(() => worktreePath({ root: "D:/repo", agentKey: "../escape", taskId: "T-001" }), /Invalid agent key/);
  assert.throws(() => worktreePath({ root: "D:/repo", agentKey: "frontend", taskId: "../escape" }), /Invalid task id/);
});

test("listWorktrees parses porcelain output", async () => {
  const execFile = (_command, _args, callback) => callback(null, { stdout: "worktree D:/repo\nHEAD abc123\n\nworktree D:/repo/runtime\nHEAD def456\nlocked\n", stderr: "" });
  const entries = await listWorktrees({ root: "D:/repo", execFile });
  assert.deepEqual(entries, [
    { path: "D:/repo", head: "abc123", locked: false, prunable: false },
    { path: "D:/repo/runtime", head: "def456", locked: true, prunable: false },
  ]);
});
