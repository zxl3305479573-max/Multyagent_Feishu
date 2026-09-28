import { execFile as defaultExecFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";

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
