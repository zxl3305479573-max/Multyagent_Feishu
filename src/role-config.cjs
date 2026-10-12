// @ts-check
// 角色配置的唯一来源：config/roles/<role>.json，每个角色一个文件。
//
// 以前角色信息分散在 config/agents.json（飞书接入）、config/policy.json（职责与工具）、
// config/agent-registry.json + profiles/ + policies/（运行预算与路径）五处，而且互相矛盾：
// 提示词里写“只写 runtime/artifacts”，实际拦截的是 workspace/{project}/artifacts。
// 现在由本模块统一加载、校验，并从 writePaths/shellMode 自动生成提示词里的权限约束，
// 保证“告诉模型的规则”和“策略层实际拦截的规则”一致。
//
// 同步读取（CommonJS），ESM 模块、RPC 扩展与脚本都可以直接使用。
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const DEFAULT_DIR = join(__dirname, "..", "config", "roles");
const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]+$/;
const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit", "bash", "powershell", "ask_user", "todo", "subagent", "create_goal", "get_goal", "update_goal", "get_task_status"]);
const SHELL_MODES = new Set(["none", "readonly", "write"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
const positiveInt = (value) => Number.isInteger(value) && value > 0;

function validateRole(role, file) {
  const errors = [];
  const at = (field, message) => errors.push(`${file}: ${field} ${message}`);
  if (!role || typeof role !== "object") return [`${file}: 不是 JSON 对象`];
  if (!KEY.test(String(role.key || ""))) at("key", "必须是小写字母、数字、下划线");
  if (typeof role.displayName !== "string" || !role.displayName.trim()) at("displayName", "不能为空");
  if (!Number.isInteger(role.order)) at("order", "必须是整数");
  if (typeof role.enabled !== "boolean") at("enabled", "必须是布尔值");
  if (!ENV_NAME.test(String(role.feishu?.appIdEnv || ""))) at("feishu.appIdEnv", "必须是环境变量名");
  if (!ENV_NAME.test(String(role.feishu?.appSecretEnv || ""))) at("feishu.appSecretEnv", "必须是环境变量名");
  for (const field of ["duty", "goal"]) if (typeof role[field] !== "string" || !role[field].trim()) at(field, "不能为空");
  if (role.workflow !== undefined && typeof role.workflow !== "string") at("workflow", "必须是字符串");
  if (!isStringList(role.rules || [])) at("rules", "必须是字符串数组");
  if (!isStringList(role.tools) || !role.tools.length) at("tools", "必须是非空字符串数组");
  else for (const tool of role.tools) if (!KNOWN_TOOLS.has(tool)) at("tools", `包含未知工具 ${tool}`);
  if (!THINKING.has(role.thinking)) at("thinking", `必须是 ${[...THINKING].join("/")}`);
  if (!isStringList(role.writePaths || [])) at("writePaths", "必须是字符串数组");
  if (!isStringList(role.denyPaths || [])) at("denyPaths", "必须是字符串数组");
  for (const path of [...(role.writePaths || []), ...(role.denyPaths || [])]) {
    if (/^(?:[A-Za-z]:|[\\/])/.test(path) || path.split(/[\\/]/).includes("..")) at("writePaths/denyPaths", `${path} 必须是仓库内的相对路径`);
  }
  if (!SHELL_MODES.has(role.shellMode)) at("shellMode", "必须是 none/readonly/write");
  const hasShell = (role.tools || []).some((tool) => tool === "bash" || tool === "powershell");
  if (role.shellMode === "none" && hasShell) at("shellMode", "为 none 时 tools 里不能有 bash/powershell");
  if (role.shellMode !== "none" && !hasShell) at("shellMode", "tools 里没有 bash/powershell 时应设为 none");
  const canWrite = (role.tools || []).some((tool) => tool === "write" || tool === "edit");
  if (canWrite && !(role.writePaths || []).length) at("writePaths", "有 write/edit 工具时必须声明可写目录");
  if (typeof role.networkAccess !== "boolean") at("networkAccess", "必须是布尔值");
  if (!isStringList(role.networkDomains || [])) at("networkDomains", "必须是字符串数组");
  if (!positiveInt(role.limits?.maxConcurrentTasks)) at("limits.maxConcurrentTasks", "必须是正整数");
  if (!positiveInt(role.limits?.maxTurns)) at("limits.maxTurns", "必须是正整数");
  if (!positiveInt(role.limits?.maxRuntimeSeconds)) at("limits.maxRuntimeSeconds", "必须是正整数");
  return errors;
}

// 从可写目录和 Shell 模式生成权限说明，放进系统提示的“约束”部分。
function permissionConstraints(role) {
  const lines = [];
  const writePaths = role.writePaths || [];
  const canWrite = (role.tools || []).some((tool) => tool === "write" || tool === "edit");
  if (canWrite && writePaths.length) lines.push(`只能写入：${writePaths.join("、")}（其余路径会被策略层拒绝）`);
  else lines.push("不能写入任何文件");
  if (role.shellMode === "none") lines.push("不能使用 Shell 命令");
  else if (role.shellMode === "readonly") lines.push("Shell 只能用于读取、检索和运行测试，不能修改文件、Git 状态或依赖");
  else lines.push("Shell 写入同样受上述目录限制；禁止删除文件、内联脚本（node -e、python -c 等）和在写入命令中切换目录");
  lines.push(role.networkAccess ? `联网仅限：${(role.networkDomains || []).join("、") || "（未配置域名）"}` : "不能访问网络");
  return lines;
}

function loadRoles({ dir = DEFAULT_DIR } = {}) {
  let files;
  try { files = readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".schema.json")); }
  catch (error) { throw new Error(`无法读取角色配置目录 ${dir}：${error.message}`); }
  const roles = [];
  const errors = [];
  for (const name of files) {
    let role;
    try { role = JSON.parse(readFileSync(join(dir, name), "utf8")); }
    catch (error) { errors.push(`${name}: JSON 解析失败（${error.message}）`); continue; }
    errors.push(...validateRole(role, name));
    if (role?.key && `${role.key}.json` !== name) errors.push(`${name}: 文件名必须与 key 一致（${role.key}.json）`);
    roles.push(role);
  }
  const keys = new Set();
  for (const role of roles) {
    if (keys.has(role.key)) errors.push(`重复的角色 key：${role.key}`);
    keys.add(role.key);
  }
  if (!roles.length) errors.push(`${dir} 下没有角色配置`);
  if (errors.length) throw new Error(`角色配置无效：\n  - ${errors.join("\n  - ")}`);
  return roles.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

// 兼容原 config/agents.json 的结构：网关、看板和脚本使用。
function toAgentDefinitions(roles) {
  return roles.map((role) => ({
    key: role.key,
    displayName: role.displayName,
    enabled: role.enabled,
    appIdEnv: role.feishu.appIdEnv,
    appSecretEnv: role.feishu.appSecretEnv,
    max_concurrent_tasks: role.limits.maxConcurrentTasks,
    max_turns: role.limits.maxTurns,
    max_runtime_seconds: role.limits.maxRuntimeSeconds,
  }));
}

// 兼容原 config/policy.json 的结构：Pi 会话、策略扩展和任务计划校验使用。
function toPolicy(roles) {
  return Object.fromEntries(roles.map((role) => [role.key, {
    duty: role.duty,
    goal: role.goal,
    constraints: [...permissionConstraints(role), ...(role.rules || [])],
    ...(role.workflow ? { workflow: role.workflow } : {}),
    tools: role.tools,
    thinking: role.thinking,
    writePaths: role.writePaths || [],
    denyPaths: role.denyPaths || [],
    shellMode: role.shellMode,
    networkAccess: role.networkAccess,
    networkDomains: role.networkDomains || [],
    ...(role.allowInlineScripts === true ? { allowInlineScripts: true } : {}),
  }]));
}

let cached = null;
function roleConfig(options) {
  if (options?.dir) {
    const roles = loadRoles(options);
    return { roles, agents: toAgentDefinitions(roles), policy: { agents: toPolicy(roles) } };
  }
  if (!cached) {
    const roles = loadRoles();
    cached = { roles, agents: toAgentDefinitions(roles), policy: { agents: toPolicy(roles) } };
  }
  return cached;
}

module.exports = { loadRoles, validateRole, permissionConstraints, toAgentDefinitions, toPolicy, roleConfig };
