import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvCatalog } from "../src/env-catalog.cjs";
import { createSettingsStore, describeSettings } from "../src/settings-store.cjs";

const roleKeys = ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"];

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try { return await fn(createSettingsStore({ file: join(dir, "settings.json"), roleKeys, log: { warn() {} } }), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("settings are validated, normalised and persisted", () => withStore(async (store, dir) => {
  await store.setMany({ PI_AGENT_MODEL: " gpt-5.1 ", PI_MAX_DISPATCH_ROUNDS: "12", PI_AGENT_WORKTREE: "true", PI_CONFIRM_ROLES: "tester, project_manager,tester" });
  assert.deepEqual(await store.toEnv(), { PI_AGENT_MODEL: "gpt-5.1", PI_MAX_DISPATCH_ROUNDS: "12", PI_AGENT_WORKTREE: "1", PI_CONFIRM_ROLES: "tester,project_manager" });
  assert.match(await readFile(join(dir, "settings.json"), "utf8"), /"PI_AGENT_MODEL": "gpt-5.1"/);
  await store.reset("PI_AGENT_MODEL");
  assert.equal((await store.toEnv()).PI_AGENT_MODEL, undefined);
}));

test("invalid values are rejected without saving anything", () => withStore(async (store) => {
  await assert.rejects(() => store.setMany({ PI_AGENT_MODEL: "ok", PI_MAX_DISPATCH_ROUNDS: "0" }), /不能小于 1/);
  await assert.rejects(() => store.set("PI_AGENT_RUNTIME", "docker"), /只能是/);
  await assert.rejects(() => store.set("PI_CONFIRM_ROLES", "ceo"), /未知角色/);
  await assert.rejects(() => store.set("PI_AGENT_MODEL", "a\nb"), /换行/);
  await assert.rejects(() => store.set("DEEPSEEK_API_KEY", "sk"), /密钥/);
  await assert.rejects(() => store.set("PI_DESKTOP_TOKEN_FILE", "x"), /桌面端管理/);
  await assert.rejects(() => store.set("NOT_A_SETTING", "x"), /未知配置项/);
  assert.deepEqual(await store.toEnv(), {});
}));

test("snapshot reports effective values and their source without exposing secrets", () => {
  const catalog = buildEnvCatalog();
  const snapshot = describeSettings({
    catalog,
    values: { PI_AGENT_MODEL: "gpt-5.1" },
    managed: { PI_EVENTS_FILE: "C:/data/events.jsonl", PI_DESKTOP_TOKEN_FILE: "C:/data/token" },
    systemEnv: { PI_AGENT_PROVIDER: "openai", OPENAI_API_KEY: "sk-system" },
    secrets: { encryptionAvailable: true, keys: [{ key: "DEEPSEEK_API_KEY", readable: true }] },
  });
  assert.deepEqual(snapshot.entries.PI_AGENT_MODEL, { value: "gpt-5.1", effective: "gpt-5.1", source: "设置" });
  assert.equal(snapshot.entries.PI_AGENT_PROVIDER.source, "系统环境变量");
  assert.equal(snapshot.entries.PI_EVENTS_FILE.effective, "C:/data/events.jsonl");
  assert.equal(snapshot.entries.PI_DESKTOP_TOKEN_FILE.source, "桌面端管理");
  assert.equal(snapshot.entries.PI_AGENT_THINKING.effective, "off");
  assert.deepEqual(snapshot.entries.DEEPSEEK_API_KEY, { configured: true, readable: true, source: "设置", fromSystemEnv: false });
  assert.equal(snapshot.entries.OPENAI_API_KEY.fromSystemEnv, true);
  assert.equal(JSON.stringify(snapshot).includes("sk-system"), false);
});
