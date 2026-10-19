// 用户能力库：给各个机器人按角色添加 Skill 或插件。
//
// - Skill：Agent Skills 标准目录（含 SKILL.md，frontmatter 写 name / description），只提供知识与操作指引，
//   由 Pi 把名称和描述列进系统提示，Agent 需要时用 read 工具读取全文。
// - 插件：Pi 扩展模块（plugin.json + 入口 .js/.mjs/.ts，默认导出 function (pi) { pi.registerTool(...) }），
//   提供新工具；代码在网关进程内执行，所以安装时必须显式确认信任，工具调用仍经过策略闸门。
//
// 文件放在数据目录 capabilities/{skills,plugins}/<name>/，启用状态与角色分配记录在 runtime/capabilities.json。
// 来源支持：本地文件夹、GitHub（owner/repo[/子目录][@分支或标签]）、桌面端直接新建 Skill。
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { readJsonFileSync, writeFileAtomic } from "../atomic-file.cjs";

const run = promisify(execFile);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const GITHUB_SPEC = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)(?:@([A-Za-z0-9_./-]+))?$/;
const PLUGIN_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const KINDS = ["skill", "plugin"];

/** GitHub 来源：owner/repo[/子目录][@ref]；拒绝 "."/".." 段和以 - 开头的 ref，避免路径穿越与参数注入。 */
export function parseGitHubSpec(spec) {
  const match = String(spec || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").match(GITHUB_SPEC);
  if (!match) throw new Error("GitHub 来源须为 owner/repo[/子目录][@分支]");
  const [, owner, repo, rawPath, ref] = match;
  const segments = [owner, repo, ...rawPath.split("/").filter(Boolean)];
  if (segments.some((part) => /^\.+$/.test(part)) || (ref && (ref.startsWith("-") || ref.includes("..")))) throw new Error("GitHub 来源包含非法路径");
  return { owner, repo, path: rawPath.split("/").filter(Boolean).join("/"), ref: ref || "" };
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (pair) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

// 复制前先体检：不允许符号链接（防止把库外文件带进来），限制文件数与总大小。
async function inspectTree(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`不支持符号链接：${relative(dir, full)}`);
      if (info.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += info.size;
        if (files > MAX_FILES) throw new Error(`文件过多（上限 ${MAX_FILES} 个）`);
        if (bytes > MAX_BYTES) throw new Error("体积超过 20MB");
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

async function readSkill(dir) {
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(skillFile)) throw new Error("目录里没有 SKILL.md");
  const meta = parseFrontmatter(await readFile(skillFile, "utf8"));
  const name = String(meta.name || "").trim();
  const description = String(meta.description || "").trim();
  if (!NAME.test(name)) throw new Error("SKILL.md 的 name 须为小写字母、数字、连字符（最长 64）");
  if (!description) throw new Error("SKILL.md 缺少 description（Agent 靠它判断何时使用这个 Skill）");
  // 再用 Pi 自己的加载器校验一遍，确保运行时能被识别。
  const loaded = loadSkillsFromDir({ dir, source: "capability" });
  const errors = loaded.diagnostics.filter((item) => item.type === "error" || item.level === "error");
  if (!loaded.skills.some((skill) => skill.name === name) || errors.length) {
    throw new Error(`Pi 无法加载该 Skill：${errors.map((item) => item.message).join("；") || "未识别"}`);
  }
  return { name, description };
}

async function readPlugin(dir) {
  const manifestFile = join(dir, "plugin.json");
  if (!existsSync(manifestFile)) throw new Error("目录里没有 plugin.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, "utf8")); } catch { throw new Error("plugin.json 不是合法 JSON"); }
  const name = String(manifest.name || "").trim();
  const description = String(manifest.description || "").trim();
  const entry = String(manifest.entry || "index.js").trim();
  const tools = Array.isArray(manifest.tools) ? manifest.tools.map(String) : [];
  if (!NAME.test(name)) throw new Error("plugin.json 的 name 须为小写字母、数字、连字符（最长 64）");
  if (!description) throw new Error("plugin.json 缺少 description");
  if (!tools.length || tools.some((tool) => !TOOL_NAME.test(tool))) throw new Error("plugin.json 的 tools 须列出插件注册的工具名（小写字母开头，字母数字下划线）");
  const entryPath = resolve(dir, entry);
  if (!entryPath.startsWith(resolve(dir) + sep) || !PLUGIN_EXTENSIONS.has(extname(entryPath)) || !existsSync(entryPath)) {
    throw new Error("plugin.json 的 entry 须是插件目录内存在的 .js/.mjs/.ts 文件");
  }
  return { name, description, entry, tools };
}

export function createCapabilityRegistry({
  root = resolve(process.cwd(), "capabilities"),
  stateFile = resolve(process.cwd(), "runtime", "capabilities.json"),
  roleKeys = [],
  git = (args, options) => run("git", args, { timeout: 120_000, windowsHide: true, ...options }),
  now = () => new Date(),
  log = console,
} = {}) {
  let state = readJsonFileSync(stateFile, { fallback: () => ({}), onCorrupt: "backup", log }) || {};
  state.skills ||= {};
  state.plugins ||= {};
  // 每次变更递增：Agent 加载器按它判断缓存是否过期，改完无需重启网关。
  let version = 0;
  const dirOf = (kind, name) => join(root, kind === "skill" ? "skills" : "plugins", name);
  const bucket = (kind) => {
    if (!KINDS.includes(kind)) throw new Error("能力类型只能是 skill 或 plugin");
    return kind === "skill" ? state.skills : state.plugins;
  };
  async function persist() {
    version += 1;
    await writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  // 把来源准备成本地目录；GitHub 来源浅克隆到临时目录，调用方用完负责清理。
  async function prepareSource(source) {
    if (source?.type === "local") {
      const dir = resolve(String(source.path || ""));
      const info = await stat(dir).catch(() => null);
      if (!info?.isDirectory()) throw new Error("本地路径不是文件夹");
      return { dir, cleanup: async () => {}, label: dir };
    }
    if (source?.type === "github") {
      const spec = parseGitHubSpec(source.spec);
      const temp = await mkdtemp(join(tmpdir(), "capability-"));
      const cleanup = () => rm(temp, { recursive: true, force: true });
      try {
        const args = ["clone", "--depth", "1", ...(spec.ref ? ["--branch", spec.ref] : []), "--", `https://github.com/${spec.owner}/${spec.repo}.git`, join(temp, "repo")];
        await git(args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      } catch (error) {
        await cleanup();
        throw new Error(`克隆 GitHub 仓库失败：${String(error.stderr || error.message).trim().slice(0, 200)}`);
      }
      const dir = join(temp, "repo", ...spec.path.split("/").filter(Boolean));
      if (!existsSync(dir)) { await cleanup(); throw new Error(`仓库里没有目录 ${spec.path}`); }
      return { dir, cleanup, label: `github:${spec.owner}/${spec.repo}${spec.path ? `/${spec.path}` : ""}${spec.ref ? `@${spec.ref}` : ""}` };
    }
    throw new Error("不支持的来源类型");
  }

  async function install({ kind, source, trustPlugin = false, roles = [] } = {}) {
    const records = bucket(kind);
    if (kind === "plugin" && trustPlugin !== true) throw new Error("插件代码会在网关进程内运行，请确认信任该插件后再安装");
    if (source?.type === "inline") {
      if (kind !== "skill") throw new Error("只能直接新建 Skill");
      return createInlineSkill({ ...source, roles });
    }
    const prepared = await prepareSource(source);
    try {
      const meta = kind === "skill" ? await readSkill(prepared.dir) : await readPlugin(prepared.dir);
      if (records[meta.name]) throw new Error(`已存在同名${kind === "skill" ? " Skill" : "插件"}：${meta.name}，请先移除再安装`);
      await inspectTree(prepared.dir);
      const target = dirOf(kind, meta.name);
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await cp(prepared.dir, target, { recursive: true, filter: (from) => !SKIP.has(basename(from)) });
      records[meta.name] = { ...meta, roles: normalizeRoles(roles), enabled: true, source: prepared.label, installedAt: now().toISOString() };
      await persist();
      return { kind, ...records[meta.name] };
    } finally {
      await prepared.cleanup();
    }
  }

  async function createInlineSkill({ name, description, body, roles }) {
    const skillName = String(name || "").trim();
    const summary = String(description || "").trim().replace(/\s+/g, " ").slice(0, 1000);
    if (!NAME.test(skillName)) throw new Error("Skill 名称须为小写字母、数字、连字符（最长 64）");
    if (!summary) throw new Error("请填写描述：Agent 靠它判断何时使用这个 Skill");
    if (!String(body || "").trim()) throw new Error("请填写 Skill 正文");
    if (state.skills[skillName]) throw new Error(`已存在同名 Skill：${skillName}`);
    const target = dirOf("skill", skillName);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${JSON.stringify(summary)}\n---\n\n${String(body).trim()}\n`, "utf8");
    try { await readSkill(target); } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
    state.skills[skillName] = { name: skillName, description: summary, roles: normalizeRoles(roles), enabled: true, source: "desktop", installedAt: now().toISOString() };
    await persist();
    return { kind: "skill", ...state.skills[skillName] };
  }

  function normalizeRoles(roles) {
    const allowed = new Set(roleKeys);
    return [...new Set((Array.isArray(roles) ? roles : []).map(String))].filter((role) => !allowed.size || allowed.has(role));
  }

  async function assign({ kind, name, roles, enabled } = {}) {
    const record = bucket(kind)[name];
    if (!record) throw new Error("找不到这个能力");
    if (roles !== undefined) record.roles = normalizeRoles(roles);
    if (enabled !== undefined) record.enabled = enabled === true;
    await persist();
    return { kind, ...record };
  }

  async function remove({ kind, name } = {}) {
    const records = bucket(kind);
    if (!records[name]) throw new Error("找不到这个能力");
    delete records[name];
    await rm(dirOf(kind, name), { recursive: true, force: true });
    await persist();
    return { removed: true };
  }

  async function list() {
    const describe = (kind) => Object.values(bucket(kind)).map((record) => ({ kind, ...record, installed: existsSync(dirOf(kind, record.name)) }));
    return { skills: describe("skill"), plugins: describe("plugin"), roles: roleKeys, root };
  }

  /** 某个角色当前启用的能力：Skill 目录、插件入口和插件声明的工具名（同步，供 Agent 启动时读取）。 */
  function forRole(agentKey) {
    const active = (records) => Object.values(records).filter((record) => record.enabled && record.roles.includes(agentKey));
    const skills = active(state.skills).map((record) => dirOf("skill", record.name)).filter((dir) => existsSync(dir));
    const plugins = active(state.plugins).filter((record) => existsSync(dirOf("plugin", record.name)));
    return {
      version,
      skillPaths: skills,
      extensionPaths: plugins.map((record) => resolve(dirOf("plugin", record.name), record.entry)),
      tools: [...new Set(plugins.flatMap((record) => record.tools))],
    };
  }

  return { install, assign, remove, list, forRole, skillsRoot: () => join(root, "skills"), getVersion: () => version };
}
