import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore } from "../desktop/electron/credential-store.cjs";
import { createGatewayProcess } from "../desktop/electron/gateway-process.cjs";

test("credential store encrypts values and exposes only configured environment keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
  try {
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (value) => Buffer.from(value).toString().slice(4) };
    const store = createCredentialStore({ file: join(root, "credentials.json"), safeStorage });
    await store.set("FEISHU_PROJECT_MANAGER_APP_ID", "app-id");
    await store.set("FEISHU_PROJECT_MANAGER_APP_SECRET", "secret");
    assert.deepEqual(await store.toEnv(), { FEISHU_PROJECT_MANAGER_APP_ID: "app-id", FEISHU_PROJECT_MANAGER_APP_SECRET: "secret" });
    const raw = await readFile(join(root, "credentials.json"), "utf8");
    assert.equal(raw.includes("secret"), false);
    const reopened = createCredentialStore({ file: join(root, "credentials.json"), safeStorage });
    assert.equal(await reopened.get("FEISHU_PROJECT_MANAGER_APP_SECRET"), "secret");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("credential store reports unavailable encryption instead of pretending keys are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
  try {
    const file = join(root, "credentials.json");
    const working = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (value) => Buffer.from(value).toString().slice(4) };
    await createCredentialStore({ file, safeStorage: working }).set("DEEPSEEK_API_KEY", "sk-test");
    const broken = { isEncryptionAvailable: () => false };
    const store = createCredentialStore({ file, safeStorage: broken, log: { error() {}, warn() {} } });
    await assert.rejects(() => store.get("DEEPSEEK_API_KEY"), /加密不可用/);
    await assert.rejects(() => store.set("DEEPSEEK_API_KEY", "x"), /加密不可用/);
    assert.deepEqual(await store.status(), { encryptionAvailable: false, keys: [{ key: "DEEPSEEK_API_KEY", readable: false }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt credential file is backed up rather than overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
  try {
    const { writeFile, readdir } = await import("node:fs/promises");
    const file = join(root, "credentials.json");
    await writeFile(file, "{\"DEEPSEEK_API_KEY\": \"abc");
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (value) => Buffer.from(value).toString().slice(4) };
    const store = createCredentialStore({ file, safeStorage, log: { warn() {} } });
    assert.deepEqual(await store.list(), []);
    assert.equal((await readdir(root)).some((name) => name.startsWith("credentials.json.corrupt-")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gateway process manager starts once and stops the child cleanly", async () => {
  const calls = [];
  const child = { once: (event, handler) => { calls.push(["once", event]); child.handlers[event] = handler; }, kill: (signal) => { calls.push(["kill", signal]); child.handlers.exit?.(0, signal); }, handlers: {} };
  const manager = createGatewayProcess({ spawnImpl: (...args) => { calls.push(["spawn", ...args]); return child; }, entry: "src/index.js", cwd: "repo" });
  assert.equal(manager.start(), child);
  assert.equal(manager.start(), child);
  await manager.stop();
  assert.deepEqual(calls.map((call) => call[0]), ["spawn", "once", "once", "once", "kill"]);
  assert.equal(calls.at(-1)[1], "SIGTERM");
});

test("gateway restart waits for the old process and uses updated credentials", async () => {
  const calls = [];
  const children = [];
  const manager = createGatewayProcess({
    spawnImpl: (...args) => {
      const child = { handlers: {}, once(event, handler) { child.handlers[event] = handler; }, kill(signal) { calls.push(["kill", signal]); child.handlers.exit?.(0, signal); } };
      children.push(child); calls.push(["spawn", ...args]); return child;
    },
    entry: "src/index.js", cwd: "repo", env: { FEISHU_PROJECT_MANAGER_APP_ID: "old" },
  });
  manager.start();
  await manager.restart({ FEISHU_PROJECT_MANAGER_APP_ID: "new" });
  assert.equal(children.length, 2);
  assert.equal(calls.find((call) => call[0] === "kill")[1], "SIGTERM");
  const latestSpawn = calls.filter((call) => call[0] === "spawn").at(-1);
  assert.equal(latestSpawn[3].env.FEISHU_PROJECT_MANAGER_APP_ID, "new");
  assert.equal(latestSpawn[3].env.ELECTRON_RUN_AS_NODE, "1");
});

test("gateway stop asks the child to shut down over IPC before killing it", async () => {
  const calls = [];
  const child = {
    connected: true,
    handlers: {},
    once(event, handler) { child.handlers[event] = handler; },
    send(message) { calls.push(["send", message.type]); setImmediate(() => child.handlers.exit?.(0, null)); },
    kill(signal) { calls.push(["kill", signal]); },
  };
  const manager = createGatewayProcess({ spawnImpl: () => child, entry: "src/index.js", cwd: "repo" });
  manager.start();
  await manager.stop();
  assert.deepEqual(calls, [["send", "shutdown"]]);
});

test("gateway stop falls back to SIGTERM when the child ignores IPC shutdown", async () => {
  const calls = [];
  const child = {
    connected: true,
    handlers: {},
    once(event, handler) { child.handlers[event] = handler; },
    send(message) { calls.push(["send", message.type]); },
    kill(signal) { calls.push(["kill", signal]); child.handlers.exit?.(null, signal); },
  };
  const manager = createGatewayProcess({ spawnImpl: () => child, entry: "src/index.js", cwd: "repo", gracefulTimeoutMs: 10 });
  manager.start();
  await manager.stop();
  assert.deepEqual(calls, [["send", "shutdown"], ["kill", "SIGTERM"]]);
});
