import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeLock, globalLockFile, readLock, releaseLock, writeLock } from "../src/gateway-lock.cjs";
import { feishuEnabled } from "../src/feishu-mode.cjs";

const agents = [{ key: "architect", appIdEnv: "ARCH_ID" }, { key: "project_manager", appIdEnv: "PM_ID" }];

test("global gateway lock is keyed by the project manager bot so every launch path finds it", () => {
  assert.equal(globalLockFile(agents, { ARCH_ID: "cli_arch", PM_ID: "cli_pm" }, "/locks"), join("/locks", "cli_pm.lock"));
  assert.equal(globalLockFile(agents, { ARCH_ID: "cli_arch" }, "/locks"), join("/locks", "cli_arch.lock"));
  assert.equal(globalLockFile(agents, {}, "/locks"), null);
  assert.equal(globalLockFile(agents, { PM_ID: "cli_pm", FEISHU_ENABLED: "false" }, "/locks"), null, "飞书关闭时不占机器人锁");
});

test("FEISHU_ENABLED defaults on and accepts common off values", () => {
  assert.equal(feishuEnabled({}), true);
  assert.equal(feishuEnabled({ FEISHU_ENABLED: "true" }), true);
  for (const value of ["false", "0", "OFF", " no "]) assert.equal(feishuEnabled({ FEISHU_ENABLED: value }), false, value);
});

test("gateway lock reads legacy pid files and ignores dead or own processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-lock-"));
  try {
    const legacy = join(dir, "legacy.lock");
    await writeFile(legacy, String(process.pid));
    assert.deepEqual(readLock(legacy), { pid: process.pid });
    assert.equal(activeLock(legacy), null, "own pid is not a foreign lock");
    assert.equal(activeLock(legacy, -1)?.pid, process.pid, "a live pid held by someone else is reported");
    await writeFile(legacy, "999999999");
    assert.equal(activeLock(legacy, -1), null, "dead pid is treated as stale");

    const file = join(dir, "nested", "bot.lock");
    writeLock(file);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.pid, process.pid);
    assert.equal(written.cwd, process.cwd());
    releaseLock(file);
    assert.equal(readLock(file), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
