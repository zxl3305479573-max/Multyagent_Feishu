import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireProjectLock, isBuildCommand, projectLockFile } from "../src/runtime/project-lock.js";
import { createPolicyFactory } from "../src/agent/policy-gate.js";
import { createAgentCliTool } from "../src/agent/tools.js";

async function tempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "project-lock-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("isBuildCommand 识别安装、构建、测试命令，常驻与只读命令不排队", () => {
  for (const command of ["npm install", "cd web && npm ci", "pnpm add react", "npm run build", "yarn test", "npx vite build", "tsc -p .", "node --test test", "pytest -q", "cargo test", "uv sync"]) {
    assert.equal(isBuildCommand(command), true, command);
  }
  for (const command of ["npm run dev", "vite", "ls -la", "git status", "cat package.json", "echo npm-install"]) {
    assert.equal(isBuildCommand(command), false, command);
  }
});

test("项目锁：持有期间第二个命令排队，释放后才拿到；不同项目互不阻塞", async () => {
  await tempRoot(async (root) => {
    const first = await acquireProjectLock({ root, project: "demo", pollMs: 5 });
    let secondAcquired = false;
    const second = acquireProjectLock({ root, project: "demo", pollMs: 5 }).then((lock) => { secondAcquired = true; return lock; });
    const other = await acquireProjectLock({ root, project: "other", pollMs: 5, timeoutMs: 50 });
    assert.ok(other, "其他项目不受影响");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(secondAcquired, false);
    await first.release();
    const lock = await second;
    assert.ok(lock.waitedMs >= 30);
    await lock.release();
    await other.release();
    assert.deepEqual(await readdir(join(root, "runtime", "locks")), []);
  });
});

test("项目锁：等待超时返回 null；失效或持有进程已退出的锁可被抢占", async () => {
  await tempRoot(async (root) => {
    const held = await acquireProjectLock({ root, project: "demo" });
    assert.equal(await acquireProjectLock({ root, project: "demo", pollMs: 5, timeoutMs: 30 }), null);
    await held.release();

    const file = projectLockFile(root, "demo");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: process.pid, token: "old", at: Date.now() - 60_000 }));
    const afterStale = await acquireProjectLock({ root, project: "demo", staleMs: 1000, timeoutMs: 100 });
    assert.ok(afterStale, "超过失效时长的锁被抢占");
    await afterStale.release();

    await writeFile(file, JSON.stringify({ pid: 2 ** 30, token: "dead", at: Date.now() }));
    const afterDead = await acquireProjectLock({ root, project: "demo", timeoutMs: 100 });
    assert.ok(afterDead, "持有进程已不存在的锁被抢占");
    await afterDead.release();
  });
});

test("策略闸门：通过检查的构建命令先排队拿锁，工具结束时释放；普通命令不排队", async () => {
  const calls = [];
  const released = [];
  const handlers = {};
  const acquireLock = async (options) => { calls.push(options); return { release: async () => { released.push(options.project); } }; };
  createPolicyFactory({ key: "frontend_developer" }, "demo", null, { acquireLock })({ on: (name, handler) => { handlers[name] = handler; } });
  const ctx = { cwd: process.cwd() };
  assert.equal(await handlers.tool_call({ toolName: "bash", toolCallId: "t1", input: { command: "npm run build" } }, ctx), undefined);
  assert.deepEqual(calls.map((item) => [item.project, item.owner]), [["demo", "frontend_developer"]]);
  assert.equal(await handlers.tool_call({ toolName: "bash", toolCallId: "t2", input: { command: "ls" } }, ctx), undefined);
  assert.equal(calls.length, 1, "普通命令不排队");
  await handlers.tool_result({ toolCallId: "t1" });
  await handlers.tool_execution_end({ toolCallId: "t1" });
  assert.deepEqual(released, ["demo"], "只释放一次");
  const blocked = await handlers.tool_call({ toolName: "bash", toolCallId: "t3", input: { command: "rm -rf workspace && npm install" } }, ctx);
  assert.equal(blocked.block, true);
  assert.equal(calls.length, 1, "被策略拦截的命令不占锁");
});

test("受控 CLI 的 test 动作在项目锁内执行", async () => {
  const order = [];
  const tool = createAgentCliTool({
    taskId: "T1",
    getProjectName: () => "demo",
    agentKey: "tester",
    execute: async (action) => { order.push(`run:${action}`); return { status: "passed" }; },
    acquireLock: async ({ project }) => { order.push(`lock:${project}`); return { release: async () => { order.push("release"); } }; },
  });
  await tool.execute("c1", { action: "test" });
  assert.deepEqual(order, ["lock:demo", "run:test", "release"]);
});
