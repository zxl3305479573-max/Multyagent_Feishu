// @ts-check
// 用户自建角色：桌面端“自定义 Agent”页面的存储层。
//
// 每个角色一个 JSON 文件，放在 customRolesDir()（数据目录 runtime/custom-roles），
// 结构与 config/roles/*.json 完全一致，由 role-config.cjs 统一加载、校验并生成权限约束。
// 保存前先 normalizeRole：补齐默认值、修正互相矛盾的字段（例如有 Shell 工具但 shellMode=none），
// 让 AI 生成的草稿和人工修改都能落成一份合法配置；仍不合法时返回可读错误，不写文件。
const { readdirSync, readFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { writeFileAtomic } = require("./atomic-file.cjs");
const { KNOWN_TOOLS, SHELL_MODES, THINKING, DEFAULT_DIR, customRolesDir, loadRoles, validateRole } = require("./role-config.cjs");

const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const SHELL_TOOLS = ["bash", "powershell"];
const WRITE_TOOLS = ["write", "edit"];
// 每个自建角色都必须拒绝的路径：凭据与会话记录。
const BASE_DENY = [".env", "runtime/sessions"];
const DEFAULT_WRITE = "workspace/{project}/artifacts";
const LIMIT_DEFAULTS = { maxConcurrentTasks: 1, maxTurns: 8, maxRuntimeSeconds: 900 };
const LIMIT_CAPS = { maxConcurrentTasks: 4, maxTurns: 40, maxRuntimeSeconds: 3600 };

// 桌面端工具白名单可选项与说明；目标/状态类工具只属于项目经理，不对自建角色开放。
const TOOL_CATALOG = [
  ["read", "读取文件"],
  ["grep", "按内容搜索文件"],
  ["find", "按名称查找文件"],
  ["ls", "列出目录"],
  ["write", "新建/覆盖文件（受可写目录限制）"],
  ["edit", "修改文件（受可写目录限制）"],
  ["bash", "执行 Shell 命令（受 Shell 模式限制）"],
  ["powershell", "执行 PowerShell 命令（受 Shell 模式限制）"],
  ["ask_user", "向用户提问澄清"],
  ["todo", "维护待办清单"],
  ["subagent", "启动子 Agent 分担检索"],
].filter(([tool]) => KNOWN_TOOLS.has(tool));
const DESIGNABLE_TOOLS = new Set(TOOL_CATALOG.map(([tool]) => tool));

const text = (value) => String(value ?? "").trim();
const textList = (value) => [...new Set((Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/)).map(text).filter(Boolean))];
const clampInt = (value, fallback, max) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback;
};

function builtInKeys() {
  return new Set(loadRoles({ dir: DEFAULT_DIR }).map((role) => role.key));
}

// 把显示名或任意字符串变成合法 key；中文等非 ASCII 字符无法转写时退化为 custom_agent。
function slugKey(value) {
  const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40);
  return KEY.test(slug) ? slug : "custom_agent";
}

function uniqueKey(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 37)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// 把草稿（AI 生成或人工编辑）整理成一份完整的角色配置。不做最终校验，校验见 saveRole。
function normalizeRole(draft = {}, { taken = new Set() } = {}) {
  const displayName = text(draft.displayName) || "自定义 Agent";
  const key = KEY.test(text(draft.key)) ? text(draft.key) : uniqueKey(slugKey(draft.key || displayName), taken);
  const tools = textList(draft.tools).filter((tool) => KNOWN_TOOLS.has(tool));
  if (!tools.length) tools.push("read", "grep", "find", "ls");
  const hasShell = tools.some((tool) => SHELL_TOOLS.includes(tool));
  const canWrite = tools.some((tool) => WRITE_TOOLS.includes(tool));
  let shellMode = SHELL_MODES.has(draft.shellMode) ? draft.shellMode : "readonly";
  if (!hasShell) shellMode = "none";
  else if (shellMode === "none") shellMode = "readonly";
  const writePaths = canWrite ? (textList(draft.writePaths).length ? textList(draft.writePaths) : [DEFAULT_WRITE]) : [];
  const networkDomains = textList(draft.networkDomains);
  const upper = key.toUpperCase();
  const limits = draft.limits || {};
  return {
    $schema: "./role.schema.json",
    key,
    displayName,
    order: Number.isInteger(draft.order) ? draft.order : 100,
    enabled: draft.enabled !== false,
    custom: true,
    feishu: {
      appIdEnv: text(draft.feishu?.appIdEnv) || `FEISHU_${upper}_APP_ID`,
      appSecretEnv: text(draft.feishu?.appSecretEnv) || `FEISHU_${upper}_APP_SECRET`,
    },
    requirement: text(draft.requirement),
    triggers: textList(draft.triggers),
    duty: text(draft.duty),
    goal: text(draft.goal),
    rules: textList(draft.rules),
    ...(text(draft.workflow) ? { workflow: text(draft.workflow) } : {}),
    tools,
    thinking: THINKING.has(draft.thinking) ? draft.thinking : "off",
    writePaths,
    denyPaths: [...new Set([...BASE_DENY, ...textList(draft.denyPaths)])],
    shellMode,
    networkAccess: draft.networkAccess === true && networkDomains.length > 0,
    networkDomains: draft.networkAccess === true ? networkDomains : [],
    limits: {
      maxConcurrentTasks: clampInt(limits.maxConcurrentTasks, LIMIT_DEFAULTS.maxConcurrentTasks, LIMIT_CAPS.maxConcurrentTasks),
      maxTurns: clampInt(limits.maxTurns, LIMIT_DEFAULTS.maxTurns, LIMIT_CAPS.maxTurns),
      maxRuntimeSeconds: clampInt(limits.maxRuntimeSeconds, LIMIT_DEFAULTS.maxRuntimeSeconds, LIMIT_CAPS.maxRuntimeSeconds),
    },
  };
}

function createCustomRoleStore({ dir = customRolesDir(), reserved = builtInKeys() } = {}) {
  const fileOf = (key) => join(dir, `${key}.json`);
  function list() {
    let names = [];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const roles = [];
    for (const name of names) {
      try {
        const role = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const errors = validateRole(role, name);
        roles.push({ ...role, ...(errors.length ? { errors } : {}) });
      } catch (error) { roles.push({ key: name.replace(/\.json$/, ""), displayName: name, errors: [`JSON 解析失败（${error.message}）`] }); }
    }
    return roles.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  }
  const takenKeys = (except = "") => new Set([...reserved, ...list().map((role) => role.key)].filter((key) => key !== except));

  // originalKey：编辑已有角色时的原 key；改了 key 视为重命名，旧文件随之删除。
  async function save(draft, { originalKey = "" } = {}) {
    const taken = takenKeys(originalKey);
    const role = normalizeRole(draft, { taken });
    const errors = [];
    if (reserved.has(role.key)) errors.push(`key ${role.key} 是内置角色，不能覆盖`);
    else if (taken.has(role.key)) errors.push(`key ${role.key} 已被其他自建角色使用`);
    if (!role.triggers.length) errors.push("triggers 至少填写一条触发条件，项目经理靠它判断何时派发");
    errors.push(...validateRole(role, `${role.key}.json`));
    if (errors.length) throw new Error(`自建角色无效：${errors.join("；")}`);
    const saved = { ...role, updatedAt: new Date().toISOString() };
    await writeFileAtomic(fileOf(role.key), `${JSON.stringify(saved, null, 2)}\n`);
    if (originalKey && originalKey !== role.key && KEY.test(originalKey) && !reserved.has(originalKey)) {
      try { unlinkSync(fileOf(originalKey)); } catch {}
    }
    return saved;
  }

  function remove(key) {
    if (!KEY.test(String(key || "")) || reserved.has(key)) throw new Error("只能删除自建角色");
    try { unlinkSync(fileOf(key)); }
    catch (error) { if (error.code === "ENOENT") throw new Error("找不到这个自建角色"); throw error; }
    return { removed: key };
  }

  return { dir, list, save, remove, takenKeys, reserved };
}

module.exports = { TOOL_CATALOG, DESIGNABLE_TOOLS, normalizeRole, slugKey, uniqueKey, createCustomRoleStore, builtInKeys };
