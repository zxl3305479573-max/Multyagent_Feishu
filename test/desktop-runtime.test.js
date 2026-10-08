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
