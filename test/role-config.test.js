import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles, roleConfig } from "../src/role-config.cjs";

const base = JSON.parse(readFileSync(new URL("../config/roles/tester.json", import.meta.url), "utf8"));

function withRoles(roles, fn) {
  const dir = mkdtempSync(join(tmpdir(), "roles-"));
  try {
    for (const role of roles) writeFileSync(join(dir, `${role.fileKey || role.key}.json`), JSON.stringify(role));
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("all six roles load in display order with complete limits", () => {
  const { roles, agents, policy } = roleConfig();
  assert.deepEqual(roles.map((role) => role.key), ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"]);
  for (const agent of agents) {
    assert.ok(agent.appIdEnv.startsWith("FEISHU_"));
    assert.ok(agent.max_runtime_seconds > 0);
  }
  assert.equal(policy.agents.auditor.tools.includes("bash"), false);
  assert.equal(policy.agents.auditor.shellMode, "none");
});

test("prompt constraints are generated from the enforced write paths", () => {
  const { policy } = roleConfig();
  for (const [key, cfg] of Object.entries(policy.agents)) {
    const text = cfg.constraints.join("\n");
    assert.equal(text.includes("runtime/artifacts"), false, `${key} still mentions runtime/artifacts`);
    for (const path of cfg.writePaths) assert.ok(text.includes(path), `${key} constraints should mention ${path}`);
  }
});

test("invalid role files are rejected with readable errors", () => {
  assert.throws(() => withRoles([{ ...base, shellMode: "none" }], (dir) => loadRoles({ dir })), /tools 里不能有 bash/);
  assert.throws(() => withRoles([{ ...base, writePaths: ["../outside"] }], (dir) => loadRoles({ dir })), /相对路径/);
  assert.throws(() => withRoles([{ ...base, tools: ["read", "rm_rf"] }], (dir) => loadRoles({ dir })), /未知工具/);
  assert.throws(() => withRoles([{ ...base, fileKey: "other" }], (dir) => loadRoles({ dir })), /文件名必须与 key 一致/);
  assert.throws(() => withRoles([{ ...base, limits: { ...base.limits, maxTurns: 0 } }], (dir) => loadRoles({ dir })), /maxTurns/);
  assert.equal(withRoles([base], (dir) => loadRoles({ dir })).length, 1);
});
