import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createCapabilityRegistry, parseGitHubSpec } from "../src/capabilities/registry.js";
import { setCapabilityRegistry } from "../src/capabilities/index.js";
import { rpcArgsFor } from "../src/runtime/agent-runner.js";
import { createPolicyFactory } from "../src/agent/policy-gate.js";
import { buildTaskPlanRoleLimits } from "../src/agent/tools.js";

const ROLES = ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"];

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "capabilities-"));
  const registry = createCapabilityRegistry({ root: join(dir, "capabilities"), stateFile: join(dir, "runtime", "capabilities.json"), roleKeys: ROLES, log: { warn() {} } });
  return { dir, registry, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function skillFixture(dir, name = "api-review", description = "审查 REST 接口设计时使用") {
  const folder = join(dir, "src-skill");
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# API 审查\n\n逐项检查路径命名、状态码与错误体。\n`);
  await writeFile(join(folder, "references", "checklist.md"), "- 使用名词复数\n");
  return folder;
}

async function pluginFixture(dir, manifest = {}) {
  const folder = join(dir, "src-plugin");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "plugin.json"), JSON.stringify({ name: "word-count", description: "统计文本字数", entry: "index.mjs", tools: ["count_words"], ...manifest }));
  await writeFile(join(folder, "index.mjs"), `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "count_words",
    label: "统计字数",
    description: "统计一段文本的字数",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) { return { content: [{ type: "text", text: String(params.text.length) }], details: {} }; },
  });
}
`);
  return folder;
}

test("GitHub specs are parsed strictly so they cannot escape the repo or inject git flags", () => {
  assert.deepEqual(parseGitHubSpec("anthropics/skills/skills/pdf@main"), { owner: "anthropics", repo: "skills", path: "skills/pdf", ref: "main" });
  assert.deepEqual(parseGitHubSpec("https://github.com/acme/tools.git"), { owner: "acme", repo: "tools", path: "", ref: "" });
  assert.throws(() => parseGitHubSpec("acme/tools/../../etc"), /非法路径/);
  assert.throws(() => parseGitHubSpec("acme/tools@--upload-pack=x"), /非法路径|owner\/repo/);
  assert.throws(() => parseGitHubSpec("acme/tools@-main"), /非法路径/);
  assert.throws(() => parseGitHubSpec("acme"), /owner\/repo/);
  assert.throws(() => parseGitHubSpec("acme/tools; rm -rf /"), /owner\/repo/);
});

test("a local skill folder is validated, copied into the library and assigned to roles", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    const source = await skillFixture(dir);
    const installed = await registry.install({ kind: "skill", source: { type: "local", path: source }, roles: ["backend_developer", "nobody"] });
    assert.equal(installed.name, "api-review");
    assert.deepEqual(installed.roles, ["backend_developer"], "unknown roles are dropped");
    assert.ok(existsSync(join(dir, "capabilities", "skills", "api-review", "references", "checklist.md")));
    assert.deepEqual(registry.forRole("backend_developer").skillPaths, [join(dir, "capabilities", "skills", "api-review")]);
    assert.deepEqual(registry.forRole("tester").skillPaths, []);
    await assert.rejects(registry.install({ kind: "skill", source: { type: "local", path: source } }), /已存在同名/);
    const state = JSON.parse(await readFile(join(dir, "runtime", "capabilities.json"), "utf8"));
    assert.equal(state.skills["api-review"].source, source);
  } finally { await cleanup(); }
});

test("invalid skills are rejected before anything is written", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    const noDescription = await skillFixture(dir, "api-review", "");
    await assert.rejects(registry.install({ kind: "skill", source: { type: "local", path: noDescription } }), /description/);
    await writeFile(join(noDescription, "SKILL.md"), "---\nname: Bad Name\ndescription: x\n---\n");
    await assert.rejects(registry.install({ kind: "skill", source: { type: "local", path: noDescription } }), /name/);
    await assert.rejects(registry.install({ kind: "skill", source: { type: "local", path: join(dir, "missing") } }), /不是文件夹/);
    assert.equal(existsSync(join(dir, "capabilities", "skills")), false);
  } finally { await cleanup(); }
});

test("symbolic links inside a capability are refused", async (t) => {
  const { dir, registry, cleanup } = await workspace();
  try {
    const source = await skillFixture(dir);
    try { await symlink(join(dir, "outside"), join(source, "link"), "junction"); }
    catch { t.skip("当前环境不允许创建链接"); return; }
    await mkdir(join(dir, "outside"), { recursive: true });
    await assert.rejects(registry.install({ kind: "skill", source: { type: "local", path: source } }), /符号链接/);
  } finally { await cleanup(); }
});

test("a skill can be created directly from the desktop", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    const created = await registry.install({ kind: "skill", source: { type: "inline", name: "sql-style", description: "写 SQL 时\n遵循团队规范", body: "关键字大写；禁止 SELECT *。" }, roles: ["backend_developer"] });
    assert.equal(created.description, "写 SQL 时 遵循团队规范");
    const text = await readFile(join(dir, "capabilities", "skills", "sql-style", "SKILL.md"), "utf8");
    assert.match(text, /^---\nname: sql-style\ndescription: "写 SQL 时 遵循团队规范"\n---/);
    await assert.rejects(registry.install({ kind: "skill", source: { type: "inline", name: "x", description: "", body: "y" } }), /描述/);
    await assert.rejects(registry.install({ kind: "plugin", source: { type: "inline", name: "x" }, trustPlugin: true }), /只能直接新建 Skill/);
  } finally { await cleanup(); }
});

test("plugins require explicit trust and a valid manifest", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    const source = await pluginFixture(dir);
    await assert.rejects(registry.install({ kind: "plugin", source: { type: "local", path: source } }), /确认信任/);
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "word-count", description: "x", entry: "../evil.mjs", tools: ["count_words"] }));
    await assert.rejects(registry.install({ kind: "plugin", source: { type: "local", path: source }, trustPlugin: true }), /entry/);
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "word-count", description: "x", entry: "index.mjs", tools: [] }));
    await assert.rejects(registry.install({ kind: "plugin", source: { type: "local", path: source }, trustPlugin: true }), /tools/);
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "word-count", description: "x", entry: "index.mjs", tools: ["count_words"] }));
    const installed = await registry.install({ kind: "plugin", source: { type: "local", path: source }, trustPlugin: true, roles: ["tester"] });
    assert.deepEqual(installed.tools, ["count_words"]);
    const tester = registry.forRole("tester");
    assert.deepEqual(tester.tools, ["count_words"]);
    assert.equal(tester.extensionPaths[0], join(dir, "capabilities", "plugins", "word-count", "index.mjs"));
  } finally { await cleanup(); }
});

test("GitHub installs clone shallowly, pick the sub-directory and clean up the temp clone", async () => {
  const { dir, cleanup } = await workspace();
  try {
    const fixture = await skillFixture(dir);
    const calls = [];
    const git = async (args) => {
      calls.push(args);
      const target = args.at(-1);
      await mkdir(join(target, "skills"), { recursive: true });
      await cp(fixture, join(target, "skills", "api-review"), { recursive: true });
      await mkdir(join(target, ".git"), { recursive: true });
      await writeFile(join(target, ".git", "HEAD"), "ref");
    };
    const github = createCapabilityRegistry({ root: join(dir, "capabilities"), stateFile: join(dir, "runtime", "capabilities.json"), roleKeys: ROLES, git, log: { warn() {} } });
    const installed = await github.install({ kind: "skill", source: { type: "github", spec: "acme/skills/skills/api-review@v1" }, roles: ["architect"] });
    assert.deepEqual(calls[0].slice(0, 6), ["clone", "--depth", "1", "--branch", "v1", "--"]);
    assert.equal(calls[0][6], "https://github.com/acme/skills.git");
    assert.equal(installed.source, "github:acme/skills/skills/api-review@v1");
    assert.equal(existsSync(join(dir, "capabilities", "skills", "api-review", ".git")), false, ".git is not copied");
    assert.equal(existsSync(calls[0].at(-1)), false, "temp clone removed");
    await assert.rejects(github.install({ kind: "skill", source: { type: "github", spec: "acme/skills/nope" } }), /没有目录 nope/);
  } finally { await cleanup(); }
});

test("assigning, disabling and removing capabilities bumps the version used to refresh agents", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    await registry.install({ kind: "skill", source: { type: "local", path: await skillFixture(dir) }, roles: ["architect"] });
    const before = registry.getVersion();
    await registry.assign({ kind: "skill", name: "api-review", roles: ["architect", "auditor"] });
    assert.ok(registry.getVersion() > before);
    assert.equal(registry.forRole("auditor").skillPaths.length, 1);
    await registry.assign({ kind: "skill", name: "api-review", enabled: false });
    assert.equal(registry.forRole("architect").skillPaths.length, 0, "disabled capabilities are not loaded");
    await registry.remove({ kind: "skill", name: "api-review" });
    assert.equal(existsSync(join(dir, "capabilities", "skills", "api-review")), false);
    assert.deepEqual((await registry.list()).skills, []);
    await assert.rejects(registry.assign({ kind: "skill", name: "api-review", enabled: true }), /找不到/);
  } finally { await cleanup(); }
});

test("Pi actually loads an assigned skill and the plugin's tool for that role", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    await registry.install({ kind: "skill", source: { type: "local", path: await skillFixture(dir) }, roles: ["backend_developer"] });
    await registry.install({ kind: "plugin", source: { type: "local", path: await pluginFixture(dir) }, trustPlugin: true, roles: ["backend_developer"] });
    const caps = registry.forRole("backend_developer");
    const agentDir = join(dir, "agent-home");
    await mkdir(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, additionalSkillPaths: caps.skillPaths, additionalExtensionPaths: caps.extensionPaths });
    await loader.reload();
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === "api-review" && /REST/.test(skill.description)));
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.ok(extensions.extensions.some((extension) => extension.tools.has("count_words")));
  } finally { await cleanup(); }
});

test("the RPC runtime receives the role's skills, plugin extensions and plugin tools", () => {
  const capabilities = { skillPaths: ["/caps/skills/api-review"], extensionPaths: ["/caps/plugins/word-count/index.mjs"], tools: ["count_words"] };
  const args = rpcArgsFor({ agent: { key: "backend_developer" }, context: {}, extensionPath: "/ext.mjs", capabilities });
  assert.deepEqual(args.slice(0, 4), ["-e", "/ext.mjs", "-e", "/caps/plugins/word-count/index.mjs"]);
  assert.match(args[args.indexOf("--tools") + 1], /count_words/);
  assert.equal(args[args.indexOf("--skill") + 1], "/caps/skills/api-review");
  const status = rpcArgsFor({ agent: { key: "backend_developer" }, context: { statusQuery: true }, extensionPath: "/ext.mjs", capabilities });
  assert.doesNotMatch(status[status.indexOf("--tools") + 1], /count_words/, "status queries do not get plugin tools");
});

test("assigned plugin tools are included in the project manager's plan limits", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    await registry.install({ kind: "plugin", source: { type: "local", path: await pluginFixture(dir) }, trustPlugin: true, roles: ["backend_developer"] });
    const limits = buildTaskPlanRoleLimits("demo", registry);
    assert.ok(limits.backend_developer.tools.includes("count_words"));
    assert.ok(!limits.frontend_developer.tools.includes("count_words"));
    assert.ok(limits.backend_developer.writePaths.includes("workspace/demo/backend"));
  } finally { await cleanup(); }
});

test("assigned skill files stay readable under a task read allowlist, other files do not", async () => {
  const { dir, registry, cleanup } = await workspace();
  try {
    await registry.install({ kind: "skill", source: { type: "local", path: await skillFixture(dir) }, roles: ["backend_developer"] });
    setCapabilityRegistry(registry);
    const handlers = [];
    createPolicyFactory({ key: "backend_developer" }, "demo", () => ({ fileReadAllowlist: ["workspace/demo"] }))({ on: (_name, handler) => handlers.push(handler) });
    const read = (path) => handlers[0]({ toolName: "read", input: { path } }, { cwd: dir });
    assert.equal(await read(join(dir, "capabilities", "skills", "api-review", "SKILL.md")), undefined);
    assert.match((await read(join(dir, "capabilities", "skills", "other", "SKILL.md")))?.reason || "", /读取白名单/);
    assert.match((await read("runtime/secret.json"))?.reason || "", /读取白名单/);
  } finally {
    setCapabilityRegistry(null);
    await cleanup();
  }
});
