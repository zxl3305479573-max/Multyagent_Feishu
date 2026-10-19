// 项目级构建锁：同一工作区里并行的切片各自写不同文件，但依赖安装、构建、测试会读写共享的
// node_modules、构建产物和端口，同时跑会互相踩。这类命令按 <工作目录>/runtime/locks/<项目>.lock
// 排队执行。用文件锁而不是进程内锁：RPC 模式下每个 Agent 是独立子进程。
// worktree 模式下每个切片有自己的工作目录，锁文件随之分开，互不阻塞。
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

// 依赖安装、构建、测试类命令；dev server 等常驻命令不在此列，否则会一直占着锁。
const BUILD_COMMAND = new RegExp([
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|update|upgrade)\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|typecheck|vitest|jest|playwright)\b`,
  String.raw`(?:npx\s+|pnpm\s+exec\s+)?(?:vite\s+build|tsc|webpack|next\s+build|vitest|jest|playwright\s+test)\b`,
  String.raw`node\s+--test\b`,
  String.raw`(?:pip|pip3|poetry|uv)\s+(?:install|add|sync)\b`,
  String.raw`(?:pytest|cargo\s+(?:build|test)|go\s+(?:build|test)|mvn|gradle|\./gradlew)\b`,
].map((part) => `(?:^|[\\s;&|(])${part}`).join("|"), "i");

export function isBuildCommand(command = "") {
  return BUILD_COMMAND.test(String(command));
}

export const PROJECT_LOCK_TIMEOUT_MS = Number(process.env.PI_PROJECT_LOCK_TIMEOUT_MS) || 10 * 60 * 1000;
// 持有超过该时长的锁视为失效（进程被杀、钩子没回调），可以被抢占。
export const PROJECT_LOCK_STALE_MS = Number(process.env.PI_PROJECT_LOCK_STALE_MS) || 30 * 60 * 1000;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function projectLockFile(root, project) {
  const name = String(project || "default").replace(/[^\w.-]+/g, "_");
  return join(resolve(root), "runtime", "locks", `${name}.lock`);
}

async function readHolder(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/**
 * 取得项目锁；等待超过 timeoutMs 返回 null（调用方照常执行，只是不再排队，避免把 Agent 卡死）。
 * @returns {Promise<null | { release: () => Promise<void>, waitedMs: number, file: string }>}
 */
export async function acquireProjectLock({
  root = process.cwd(),
  project,
  owner = "",
  timeoutMs = PROJECT_LOCK_TIMEOUT_MS,
  staleMs = PROJECT_LOCK_STALE_MS,
  pollMs = 500,
  now = Date.now,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const file = projectLockFile(root, project);
  await mkdir(join(file, ".."), { recursive: true });
  const token = `${process.pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  const started = now();
  for (;;) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner, token, at: now() }));
      await handle.close();
      let released = false;
      return {
        file,
        waitedMs: now() - started,
        async release() {
          if (released) return;
          released = true;
          // 只删自己的锁：失效被抢占后，别人的锁不能被这里误删。
          if ((await readHolder(file))?.token === token) await unlink(file).catch(() => {});
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = await readHolder(file);
    const expired = !holder || now() - Number(holder.at || 0) > staleMs || (holder.pid !== process.pid && !isAlive(holder.pid));
    if (expired) {
      await unlink(file).catch(() => {});
      continue;
    }
    if (now() - started >= timeoutMs) return null;
    await sleep(pollMs);
  }
}
