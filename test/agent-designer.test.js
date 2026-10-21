import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import customRoles from "../src/custom-roles.cjs";
import { buildDesignPrompt, createCustomAgentService, designAgent, parseDesign } from "../src/agent-designer.js";

const { createCustomRoleStore } = customRoles;

const design = {
  key: "doc_writer", displayName: "文档撰写员", duty: "撰写使用文档。", goal: "交付可直接发布的文档。",
  rules: ["只写 Markdown"], triggers: ["需要补充文档时"], tools: ["read", "write"], shellMode: "none", rationale: "只需读写文件",
};
const reply = (overrides = {}) => async () => JSON.stringify({ ...design, ...overrides });

test("buildDesignPrompt asks the model to infer triggers when the user gave none", () => {
  const prompt = buildDesignPrompt({ requirement: "写文档" });
  assert.match(prompt, /用户需求：写文档/);
  assert.match(prompt, /用户未给出触发条件/);
  assert.doesNotMatch(prompt, /期望的显示名|团队已有角色|当前草稿/);
  assert.doesNotMatch(prompt, /\n\n\n/, "empty optional sections leave no blank gaps");
});

test("buildDesignPrompt includes display name, team duties and the current draft", () => {
  const prompt = buildDesignPrompt({
    requirement: "写文档",
    triggers: ["发布前"],
    displayName: "文档员",
    team: [{ key: "tester", displayName: "测试", duty: "跑测试" }, { key: "architect", displayName: "架构师" }],
    current: { key: "doc_writer", rules: ["手工规则"] },
  });
  assert.match(prompt, /- 发布前/);
  assert.match(prompt, /期望的显示名：文档员/);
  assert.match(prompt, /- tester（测试）：跑测试/);
  assert.match(prompt, /- architect（架构师）$/m);
  assert.match(prompt, /"手工规则"/);
});

test("parseDesign extracts the outermost object and reports malformed JSON", () => {
  assert.deepEqual(parseDesign("设计如下 {\"limits\":{\"maxTurns\":5}} 以上"), { limits: { maxTurns: 5 } });
  assert.throws(() => parseDesign("{key: data}"), /不是合法 JSON/);
  assert.throws(() => parseDesign(""), /没有返回 JSON/);
  assert.throws(() => parseDesign(null), /没有返回 JSON/);
});

test("designAgent requires a model and surfaces unparseable replies", async () => {
  await assert.rejects(designAgent({ requirement: "写文档" }), /模型不可用/);
  await assert.rejects(designAgent({ requirement: "写文档", generate: async () => "抱歉" }), /没有返回 JSON/);
});

test("designAgent passes a JSON-only system prompt and trims blank user triggers", async () => {
  let input;
  const { role } = await designAgent({
    requirement: "  写文档  ",
    triggers: ["  ", "发布前", ""],
    generate: async (value) => { input = value; return JSON.stringify(design); },
  });
  assert.equal(input.system, "你只输出 JSON。");
  assert.match(input.prompt, /用户需求：写文档\n/);
  assert.deepEqual(role.triggers, ["发布前", "需要补充文档时"]);
  assert.equal(role.requirement, "写文档");
});

test("designAgent keeps the current key and the user's display name when redesigning", async () => {
  const { role } = await designAgent({
    requirement: "写文档",
    displayName: "我的文档员",
    current: { key: "my_docs" },
    generate: reply({ key: "something_else", displayName: "AI 起的名字" }),
  });
  assert.equal(role.key, "my_docs");
  assert.equal(role.displayName, "我的文档员");
});

test("designAgent never proposes a key that is already taken", async () => {
  const taken = new Set(["tester", "doc_writer"]);
  assert.equal((await designAgent({ requirement: "写文档", taken, generate: reply({ key: "tester" }) })).role.key, "tester_2");
  assert.equal((await designAgent({ requirement: "写文档", taken, generate: reply() })).role.key, "doc_writer_2");
  assert.equal((await designAgent({ requirement: "写文档", taken, generate: reply({ key: "Doc Helper" }) })).role.key, "doc_helper");
});

test("designAgent falls back to safe defaults when the model omits fields", async () => {
  const { role, rationale } = await designAgent({ requirement: "写文档", generate: async () => "{}" });
  assert.equal(role.key, "agent", "derived from the default display name 自定义 Agent");
  assert.deepEqual(role.tools, ["read", "grep", "find", "ls"]);
  assert.equal(role.shellMode, "none");
  assert.equal(rationale, "");
});

test("service.design hides the edited role from the team and frees its key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-designer-"));
  try {
    const store = createCustomRoleStore({ dir, reserved: new Set(["tester"]) });
    await store.save({ ...design, requirement: "写文档" });
    let prompt = "";
    const service = createCustomAgentService({
      store,
      builtInRoles: [{ key: "tester", displayName: "测试", duty: "跑测试" }],
      generate: async (input) => { prompt = input.prompt; return JSON.stringify(design); },
    });

    const fresh = await service.design({ requirement: "再来一个文档员" });
    assert.match(prompt, /doc_writer（文档撰写员）/);
    assert.equal(fresh.role.key, "doc_writer_2");

    const edited = await service.design({ requirement: "写文档", originalKey: "doc_writer" });
    assert.doesNotMatch(prompt, /doc_writer（/);
    assert.match(prompt, /tester（测试）：跑测试/);
    assert.equal(edited.role.key, "doc_writer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("service.list flags broken role files as invalid and exposes the tool catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-designer-"));
  try {
    writeFileSync(join(dir, "broken.json"), "{not json");
    const service = createCustomAgentService({ store: createCustomRoleStore({ dir, reserved: new Set(["tester"]) }) });
    const listed = service.list();
    assert.equal(listed.agents[0].key, "broken");
    assert.equal(listed.agents[0].status, "invalid");
    assert.equal(listed.restartNeeded, true);
    assert.deepEqual(listed.reserved, ["tester"]);
    assert.ok(listed.tools.every((tool) => tool.name && tool.label));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
