import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreePatch, collectWorktreeChanges, worktreePath, listWorktrees } from "../src/runtime/worktree.js";

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

test("collectWorktreeChanges stages all worktree changes and writes a reviewable patch", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "worktree-patch-"));
  const calls = [];
  const execFile = (_command, args, callback) => {
    calls.push(args.join(" "));
    if (args.includes("status")) return callback(null, { stdout: " M src/a.js\n?? src/b.js\n", stderr: "" });
    if (args.includes("diff")) return callback(null, { stdout: "diff --git a/src/a.js b/src/a.js\n+new\n", stderr: "" });
    return callback(null, { stdout: "", stderr: "" });
  };
  try {
    const result = await collectWorktreeChanges({
      root: "D:/repo",
      agentKey: "frontend_developer",
      taskId: "T-1",
      artifactsDir,
      execFile,
    });
    assert.equal(result.empty, false);
    assert.deepEqual(result.files, [
      { status: "M", path: "src/a.js" },
      { status: "??", path: "src/b.js" },
    ]);
    assert.match(result.patchPath, /worktree-changes\.patch$/);
    assert.match(await readFile(result.patchPath, "utf8"), /diff --git/);
    assert.ok(calls.some((line) => line.includes("add -A")));
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("collectWorktreeChanges returns an empty result when the worktree is clean", async () => {
  const execFile = (_command, args, callback) => {
    if (args.includes("status")) return callback(null, { stdout: "", stderr: "" });
    return callback(null, { stdout: "", stderr: "" });
  };
  const result = await collectWorktreeChanges({ root: "D:/repo", agentKey: "tester", taskId: "T-2", execFile });
  assert.equal(result.empty, true);
  assert.equal(result.patchPath, null);
});

test("applyWorktreePatch requires explicit confirmation and reports conflicts instead of overwriting", async () => {
  await assert.rejects(
    () => applyWorktreePatch({ root: "D:/repo", agentKey: "frontend_developer", taskId: "T-1", execFile: () => {} }),
    /confirm: true/,
  );

  const root = await mkdtemp(join(tmpdir(), "worktree-apply-"));
  try {
    const conflictExec = (_command, args, callback) => {
      if (args.includes("diff")) return callback(null, { stdout: "patch-body", stderr: "" });
      if (args.includes("apply")) return callback(Object.assign(new Error("conflict"), { code: 1 }));
      return callback(null, { stdout: "", stderr: "" });
    };
    const conflict = await applyWorktreePatch({ root, agentKey: "frontend_developer", taskId: "T-1", confirm: true, execFile: conflictExec });
    assert.equal(conflict.applied, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.patchPath, /worktree-patches/);

    const successExec = (_command, args, callback) => {
      if (args.includes("diff")) return callback(null, { stdout: "patch-body", stderr: "" });
      return callback(null, { stdout: "", stderr: "" });
    };
    const applied = await applyWorktreePatch({ root, agentKey: "frontend_developer", taskId: "T-1", confirm: true, execFile: successExec });
    assert.equal(applied.applied, true);
    assert.equal(applied.conflict, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
