import { execFile as defaultExecFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const exec = promisify(defaultExecFile);

function safePart(value, label) {
  const part = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === "." || part === "..") {
    throw new Error(`Invalid ${label}`);
  }
  return part;
}

export function worktreePath({ root = process.cwd(), agentKey, taskId } = {}) {
  const agent = safePart(agentKey, "agent key");
  const task = safePart(taskId, "task id");
  return join(resolve(root), "runtime", "workspaces", agent, task);
}

function assertWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Worktree path escapes root");
}

export async function createWorktree({ root = process.cwd(), agentKey, taskId, base = "HEAD", execFile = defaultExecFile } = {}) {
  const target = worktreePath({ root, agentKey, taskId });
  assertWithin(root, target);
  await mkdir(join(resolve(root), "runtime", "workspaces", safePart(agentKey, "agent key")), { recursive: true });
  const run = promisify(execFile);
  await run("git", ["-C", resolve(root), "worktree", "add", "--detach", target, base]);
  return target;
}

export async function removeWorktree({ root = process.cwd(), agentKey, taskId, execFile = defaultExecFile, force = false } = {}) {
  const target = worktreePath({ root, agentKey, taskId });
  assertWithin(root, target);
  const run = promisify(execFile);
  try {
    await run("git", ["-C", resolve(root), "worktree", "remove", ...(force ? ["--force"] : []), target]);
  } catch (error) {
    if (!force) throw error;
    await rm(target, { recursive: true, force: true });
  }
  return target;
}

export async function listWorktrees({ root = process.cwd(), execFile = defaultExecFile } = {}) {
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", resolve(root), "worktree", "list", "--porcelain"]);
  return String(stdout).split(/\n(?=worktree )/).filter(Boolean).map((entry) => {
    const path = entry.match(/^worktree (.+)$/m)?.[1] || null;
    const head = entry.match(/^HEAD ([0-9a-f]+)$/m)?.[1] || null;
    return { path, head, locked: /^locked$/m.test(entry), prunable: /^prunable/m.test(entry) };
  });
}

// 收集工作树内的全部改动（含未跟踪文件）为可审查补丁，不触碰主工作区。
export async function collectWorktreeChanges({ root = process.cwd(), agentKey, taskId, artifactsDir = null, execFile = defaultExecFile } = {}) {
  const target = worktreePath({ root, agentKey, taskId });
  assertWithin(root, target);
  const run = promisify(execFile);
  await run("git", ["-C", target, "add", "-A"]);
  const { stdout: statusOut } = await run("git", ["-C", target, "status", "--porcelain"]);
  const files = String(statusOut)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
  if (!files.length) return { path: target, files: [], patchPath: null, empty: true, bytes: 0 };
  const { stdout: patch } = await run("git", ["-C", target, "diff", "--cached", "--binary"]);
  let patchPath = null;
  if (artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    patchPath = join(artifactsDir, "worktree-changes.patch");
    await writeFile(patchPath, String(patch));
  }
  return { path: target, files, patchPath, empty: false, bytes: Buffer.byteLength(String(patch)) };
}

// 合并必须由调用方显式确认；冲突时只返回冲突信息，不强行覆盖主工作区。
export async function applyWorktreePatch({ root = process.cwd(), agentKey, taskId, confirm = false, execFile = defaultExecFile } = {}) {
  if (confirm !== true) throw new Error("applyWorktreePatch requires confirm: true");
  const target = worktreePath({ root, agentKey, taskId });
  assertWithin(root, target);
  const run = promisify(execFile);
  await run("git", ["-C", target, "add", "-A"]);
  const { stdout: patch } = await run("git", ["-C", target, "diff", "--cached", "--binary"]);
  if (!String(patch).trim()) return { applied: false, empty: true, conflict: false };
  const patchPath = join(resolve(root), "runtime", "worktree-patches", `${safePart(agentKey, "agent key")}-${safePart(taskId, "task id")}.patch`);
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, String(patch));
  try {
    await run("git", ["-C", resolve(root), "apply", "--3way", patchPath]);
    return { applied: true, conflict: false, patchPath };
  } catch (error) {
    return { applied: false, conflict: true, patchPath, error: error.message };
  }
}
