import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import customRoles from "../src/custom-roles.cjs";
import { DEFAULT_DIR, loadRoles, toAgentDefinitions, toPolicy } from "../src/role-config.cjs";
import { createCustomAgentService, designAgent, parseDesign } from "../src/agent-designer.js";
import { customRoleCatalog } from "../src/agent/prompts.js";

const { createCustomRoleStore, normalizeRole } = customRoles;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "custom-roles-"));
}

const draft = {
  key: "data_analyst",
  displayName: "数据分析师",
  requirement: "分析接口日志找出性能瓶颈",
  triggers: ["用户提到接口慢或超时"],
  duty: "分析日志与指标，定位性能瓶颈。",
  goal: "交付带证据的性能分析报告。",
  rules: ["结论必须引用日志证据"],
  tools: ["read", "grep", "write", "bash"],
  shellMode: "none",
};

test("normalizeRole repairs contradictory permissions and fills defaults", () => {
  const role = normalizeRole({ ...draft, tools: ["read", "bash", "write", "rm_rf"], writePaths: [] });
  assert.deepEqual(role.tools, ["read", "bash", "write"]);
  assert.equal(role.shellMode, "readonly", "a shell tool cannot run with shellMode none");
  assert.deepEqual(role.writePaths, ["workspace/{project}/artifacts"]);
  assert.ok(role.denyPaths.includes(".env"));
  assert.equal(role.feishu.appIdEnv, "FEISHU_DATA_ANALYST_APP_ID");
  assert.equal(role.custom, true);
  assert.equal(normalizeRole({ ...draft, tools: ["read"], shellMode: "write" }).shellMode, "none");
  assert.equal(normalizeRole({ ...draft, networkAccess: true, networkDomains: [] }).networkAccess, false);
  assert.equal(normalizeRole({ ...draft, limits: { maxTurns: 9999 } }).limits.maxTurns, 40);
});

test("normalizeRole derives a unique key when none is valid", () => {
  const taken = new Set(["custom_agent"]);
  assert.equal(normalizeRole({ displayName: "数据分析师" }, { taken }).key, "custom_agent_2");
  assert.equal(normalizeRole({ key: "Log Reviewer!" }).key, "log_reviewer");
});

test("store saves, lists, renames and removes custom roles", async () => {
  const dir = tempDir();
  try {
    const store = createCustomRoleStore({ dir });
    const saved = await store.save(draft);
    assert.equal(saved.key, "data_analyst");
    assert.ok(saved.updatedAt);
    assert.deepEqual(store.list().map((role) => role.key), ["data_analyst"]);

    const renamed = await store.save({ ...saved, key: "perf_analyst" }, { originalKey: "data_analyst" });
    assert.equal(renamed.key, "perf_analyst");
    assert.equal(existsSync(join(dir, "data_analyst.json")), false, "rename removes the old file");

    store.remove("perf_analyst");
    assert.deepEqual(store.list(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store rejects built-in keys, duplicates and roles without triggers", async () => {
  const dir = tempDir();
  try {
    const store = createCustomRoleStore({ dir });
    await assert.rejects(store.save({ ...draft, key: "tester" }), /内置角色/);
    await assert.rejects(store.save({ ...draft, triggers: [] }), /触发条件/);
    await store.save(draft);
    await assert.rejects(store.save({ ...draft, displayName: "另一个" }), /已被其他自建角色使用/);
    assert.throws(() => store.remove("tester"), /只能删除自建角色/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom roles load alongside built-ins; invalid or colliding ones are skipped", async () => {
  const dir = tempDir();
  try {
    await createCustomRoleStore({ dir }).save(draft);
    writeFileSync(join(dir, "broken.json"), "{not json");
    const tester = JSON.parse(readFileSync(join(DEFAULT_DIR, "tester.json"), "utf8"));
    writeFileSync(join(dir, "tester.json"), JSON.stringify(tester));
    const warnings = [];
    const roles = loadRoles({ customDir: dir, log: { warn: (line) => warnings.push(line) } });
    const custom = roles.filter((role) => role.custom);
    assert.deepEqual(custom.map((role) => role.key), ["data_analyst"]);
    assert.equal(roles.filter((role) => role.key === "tester").length, 1);
    assert.equal(warnings.length, 2);
    assert.equal(toAgentDefinitions(roles).find((agent) => agent.key === "data_analyst").custom, true);
    const policy = toPolicy(roles).data_analyst;
    assert.deepEqual(policy.triggers, draft.triggers);
    assert.ok(policy.constraints.some((line) => line.includes("workspace/{project}/artifacts")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseDesign tolerates fenced JSON and rejects prose", () => {
  assert.deepEqual(parseDesign("好的：\n```json\n{\"key\":\"a_b\"}\n```"), { key: "a_b" });
  assert.throws(() => parseDesign("无法设计"), /没有返回 JSON/);
});

test("designAgent keeps user triggers, filters tools and normalizes the draft", async () => {
  let prompt = "";
  const { role, rationale } = await designAgent({
    requirement: "审查依赖许可证",
    triggers: ["新增第三方依赖时"],
    team: [{ key: "tester", displayName: "测试" }],
    generate: async (input) => {
      prompt = input.prompt;
      return JSON.stringify({
        key: "license_auditor", displayName: "许可证审查员", duty: "审查依赖许可证。", goal: "输出许可证风险清单。",
        rules: ["只读审查"], triggers: ["发布前"], tools: ["read", "grep", "create_goal"], shellMode: "write", rationale: "只需读取",
      });
    },
  });
  assert.match(prompt, /新增第三方依赖时/);
  assert.match(prompt, /tester（测试）/);
  assert.equal(role.key, "license_auditor");
  assert.deepEqual(role.triggers, ["新增第三方依赖时", "发布前"]);
  assert.deepEqual(role.tools, ["read", "grep"], "project-manager-only tools are not designable");
  assert.equal(role.shellMode, "none");
  assert.equal(role.requirement, "审查依赖许可证");
  assert.equal(rationale, "只需读取");
  await assert.rejects(designAgent({ requirement: " ", generate: async () => "{}" }), /需求/);
});

test("service marks unsaved-to-runtime changes as pending restart", async () => {
  const dir = tempDir();
  try {
    const store = createCustomRoleStore({ dir });
    const saved = await store.save(draft);
    const fresh = createCustomAgentService({ store, loadedRoles: [], generate: async () => "{}" });
    assert.equal(fresh.list().agents[0].status, "pending");
    assert.equal(fresh.list().restartNeeded, true);
    const running = createCustomAgentService({ store, loadedRoles: [{ ...saved, custom: true }], generate: async () => "{}" });
    assert.equal(running.list().agents[0].status, "active");
    assert.equal(running.list().restartNeeded, false);
    store.remove("data_analyst");
    assert.equal(running.list().restartNeeded, true, "a removed role stays loaded until restart");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("project manager prompt lists custom roles with their triggers", () => {
  const lines = customRoleCatalog(
    [{ key: "data_analyst", displayName: "数据分析师", custom: true, enabled: true }, { key: "tester", displayName: "测试" }],
    { data_analyst: { duty: "分析性能", triggers: ["接口超时"] } },
  ).join("\n");
  assert.match(lines, /数据分析师（data_analyst）：分析性能/);
  assert.match(lines, /触发条件：接口超时/);
  assert.doesNotMatch(lines, /（tester）/);
  assert.deepEqual(customRoleCatalog([{ key: "tester", displayName: "测试" }], {}), []);
});
