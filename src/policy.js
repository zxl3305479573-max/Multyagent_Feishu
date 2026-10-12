// @ts-check
// 路径级策略校验（纯函数，可单元测试）。
// 语义：
//   - writePaths：写入白名单目录，write/edit 的落点必须在其下。
//   - denyPaths：写入黑名单目录，即使白名单允许，也禁止写。
//   - 敏感文件（.env 等）由 pi-agent.js 里的 SENSITIVE_PATTERNS 全局拦截，不在这里。
import { resolve, relative, isAbsolute } from "node:path";

function norm(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// 把工具参数里的 path 解析为绝对路径；无效输入返回 null。
export function resolvePath(cwd, p) {
  if (!p || typeof p !== "string") return null;
  return resolve(cwd, p);
}

// 判断绝对路径 absPath 是否在 basePaths 中某个目录之下（含目录本身）。
export function isWithin(cwd, absPath, basePaths) {
  if (!Array.isArray(basePaths) || basePaths.length === 0) return false;
  const target = norm(absPath);
  return basePaths.some((base) => {
    const absBase = norm(resolve(cwd, base));
    const rel = relative(absBase, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

// 判断绝对路径 absPath 是否命中 denyPaths 中某个目录。
export function isDenied(cwd, absPath, denyPaths) {
  if (!Array.isArray(denyPaths) || denyPaths.length === 0) return false;
  const target = norm(absPath);
  return denyPaths.some((base) => {
    const absDeny = norm(resolve(cwd, base));
    const rel = relative(absDeny, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

// 删除类命令拦截：策略只允许创建与写入，不允许删除。
const DELETE_PATTERNS = [
  /(^|[\s;&|(])rm(\s|$)/,
  /(^|[\s;&|(])rmdir(\s|$)/,
  /(^|[\s;&|(])unlink(\s|$)/,
  /(^|[\s;&|(])del(\s|$)/i,
  /(^|[\s;&|(])erase(\s|$)/i,
  /(^|[\s;&|(])rd(\s|$)/i,
  /Remove-Item/i,
  /git\s+clean/i,
  /(^|[\s;&|(])shred(\s|$)/,
  /(^|[\s;&|(])ri(\s|$)/i,
  /\bgit\s+rm\b/i,
  /\bfind\b[^|;&]*\s-delete\b/i,
  /\b(?:rmSync|unlinkSync|rmdirSync|rimraf|shutil\.rmtree|os\.remove|os\.unlink)\b/,
  /\[System\.IO\.(?:File|Directory)\]::Delete/i,
];

// 判断命令是否为删除类操作。纯函数，便于测试。
export function isDeleteCommand(command) {
  return DELETE_PATTERNS.some((re) => re.test(String(command || "")));
}

const NETWORK_PATTERNS = [
  /https?:\/\//i,
  /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|start-bitstransfer|ssh|scp|sftp|ftp|nc|ncat|telnet)\b/i,
  /\bNet\.WebClient\b|\bSystem\.Net\.Http\b/i,
  /\b(?:git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|i)|pnpm\s+(?:install|add)|yarn\s+(?:add|install)|pip\s+install|python(?:3)?\s+-m\s+pip\s+install|go\s+get|docker\s+pull)\b/i,
];

function networkHosts(command) {
  const text = String(command || "");
  const hosts = [...text.matchAll(/https?:\/\/[^\s'"<>]+/gi)].flatMap(([url]) => {
    try { return [new URL(url.replace(/[),;]+$/, "")).hostname.toLowerCase().replace(/^www\./, "")]; }
    catch { return []; }
  });
  if (/\b(?:npm\s+(?:install|i)|pnpm\s+(?:install|add)|yarn\s+(?:add|install))\b/i.test(text)) {
    const registry = text.match(/(?:--registry(?:=|\s+))https?:\/\/([^\s/]+)/i)?.[1];
    hosts.push(registry ? registry.toLowerCase().replace(/^www\./, "") : "registry.npmjs.org");
  }
  if (/\b(?:pip\s+install|python(?:3)?\s+-m\s+pip\s+install)\b/i.test(text)) {
    const index = text.match(/(?:--index-url|--extra-index-url)\s+https?:\/\/([^\s/]+)/i)?.[1];
    hosts.push(index ? index.toLowerCase().replace(/^www\./, "") : "pypi.org");
  }
  if (/\bgit\s+(?:clone|fetch|pull|push)\b/i.test(text) && hosts.length === 0) hosts.push("github.com");
  return [...new Set(hosts)];
}

export function checkNetworkAllowed(command, { enabled = false, domains = [] } = {}) {
  const text = String(command || "");
  if (!NETWORK_PATTERNS.some((pattern) => pattern.test(text))) return { allowed: true, network: false, hosts: [] };
  const allowedDomains = (Array.isArray(domains) ? domains : []).map((domain) => String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")).filter(Boolean);
  const hosts = networkHosts(text);
  if (!enabled) return { allowed: false, network: true, hosts, reason: "network access is disabled" };
  const allowed = hosts.length > 0 && hosts.every((host) => host === "" || allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  return allowed ? { allowed: true, network: true, hosts } : { allowed: false, network: true, hosts, reason: "network domain is not allowlisted" };
}

// 把 writePaths 里的 {project} 占位符替换为实际项目名（未提供时用 default 兜底）。
export function resolveWritePaths(writePaths, projectName) {
  const project = projectName || "default";
  return (writePaths || []).map((p) => p.replace(/\{project\}/g, project));
}

// 写入校验：deny 优先于 allow；配置了 writePaths 时必须在白名单内。
export function checkWriteAllowed(cwd, path, { writePaths = [], denyPaths = [] } = {}) {
  const abs = resolvePath(cwd, path);
  if (!abs) return { allowed: false, reason: "无效路径" };
  if (isDenied(cwd, abs, denyPaths)) {
    return { allowed: false, reason: `路径 ${path} 命中禁止名单` };
  }
  if (writePaths.length > 0 && !isWithin(cwd, abs, writePaths)) {
    return { allowed: false, reason: `路径 ${path} 不在写入白名单内` };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Shell 命令写入/执行边界。
//
// write/edit 工具的落点由 checkWriteAllowed 校验，但 bash/powershell 可以绕过它直接写文件。
// 这里对命令做保守的静态分析：
//   - 内联脚本解释器（node -e、python -c、powershell -Command/-EncodedCommand、
//     Invoke-Expression、eval、bash -c 等）无法静态判断其行为，一律拒绝（角色显式
//     allowInlineScripts 时放行）。
//   - 重定向（>、>>、tee、Out-File、Set-Content……）以及 cp/mv/mkdir/touch/sed -i 等
//     改写类命令必须把目标路径限制在角色 writePaths 内；含 cd/Set-Location 时目标
//     无法可靠解析，直接拒绝。
//   - shellMode=readonly 的角色不允许任何改写类命令（重定向到 writePaths 内的报告文件除外），
//     也不允许改变 Git 状态。
// 静态分析只能降低误操作和越权的概率，不能替代进程级隔离；需要强隔离时请开启
// PI_AGENT_WORKTREE 或在受限账户/容器中运行 Agent。
// ---------------------------------------------------------------------------

const INLINE_SCRIPT_PATTERNS = [
  /\b(?:node|nodejs|deno|bun)(?:\.exe)?\s+(?:[^|;&]*\s)?(?:-e|--eval|-p|--print)\b/i,
  /\b(?:python|python3|py|ruby|perl|php)(?:\.exe)?\s+(?:[^|;&]*\s)?-(?:c|e|r)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\s+(?:[^|;&]*\s)?-(?:c|command|e|enc|encodedcommand)\b/i,
  /\b(?:bash|sh|zsh|dash)(?:\.exe)?\s+(?:[^|;&]*\s)?-c\b/i,
  /\bcmd(?:\.exe)?\s+\/[ck]\b/i,
  /\b(?:Invoke-Expression|iex)\b/i,
  /(^|[\s;&|(])eval(\s|$)/,
  /\bStart-Process\b/i,
  /\[ScriptBlock\]::Create/i,
  /<<-?\s*['"]?\w+/, // heredoc 把任意脚本喂给解释器
];

const CHANGE_DIR_PATTERN = /(^|[\s;&|(])(?:cd|chdir|pushd|Set-Location|sl)(\s|$)/i;

// 改写类命令：目标路径取最后一个非选项参数（或 -Path/-Destination/-FilePath 的值）。
const MUTATING_COMMANDS = new Map([
  ["cp", "last"], ["mv", "last"], ["install", "last"], ["ln", "last"], ["rsync", "last"],
  ["mkdir", "all"], ["touch", "all"], ["chmod", "rest"], ["chown", "rest"], ["truncate", "all"],
  ["copy-item", "dest"], ["move-item", "dest"], ["rename-item", "path"], ["new-item", "path"],
  ["set-content", "path"], ["add-content", "path"], ["out-file", "path"], ["clear-content", "path"],
  ["copy", "last"], ["move", "last"], ["ren", "first"], ["md", "all"], ["xcopy", "last"], ["robocopy", "second"],
]);

const GIT_MUTATING = /\bgit\s+(?:add|commit|checkout|switch|reset|restore|apply|am|merge|rebase|cherry-pick|revert|stash|push|pull|tag|branch\s+-[dDmM]|worktree|clean|mv|rm|init|config)\b/i;
const PACKAGE_MUTATING = /\b(?:npm|pnpm|yarn|pip|pip3)\s+(?:install|i|add|remove|uninstall|update|upgrade|link|publish|ci)\b/i;

// 把命令按 && || ; | 换行切成片段，再按引号做简单分词。
export function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  const text = String(command || "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && text[i + 1] === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "|" && text[i + 1] === "|") || (ch === "&" && text[i + 1] === "&")) i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function tokenizeShell(segment) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(segment || "")))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

const NULL_TARGETS = new Set(["/dev/null", "nul", "$null", "nul:", "/dev/stdout", "/dev/stderr"]);

// 提取重定向目标：> file、>> file、1> file、2> file（2>&1 这类句柄复制除外）。
export function redirectTargets(segment) {
  const targets = [];
  const re = /(?:^|[^<>&\d])(\d?)(>>?)(?!&)\s*("([^"]*)"|'([^']*)'|[^\s;&|<>]+)/g;
  let match;
  while ((match = re.exec(String(segment || "")))) {
    const target = match[4] ?? match[5] ?? match[3];
    if (target && !NULL_TARGETS.has(target.toLowerCase())) targets.push(target);
  }
  return targets;
}

function stripRedirects(segment) {
  return String(segment || "").replace(/\d?>>?&?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g, " ");
}

function positional(tokens) {
  const out = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^-{1,2}[A-Za-z]/.test(token) || /^\/[A-Za-z]{1,3}$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

function namedArg(tokens, names) {
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (names.includes(tokens[i].toLowerCase())) return tokens[i + 1];
  }
  return null;
}

function mutationTargets(tokens) {
  const name = String(tokens[0] || "").toLowerCase().replace(/\.exe$/, "");
  const mode = MUTATING_COMMANDS.get(name);
  if (name === "sed" && tokens.some((token) => /^-i/.test(token) || token === "--in-place")) {
    const args = positional(tokens);
    return { mutating: true, targets: args.slice(1) };
  }
  if (name === "tee") return { mutating: true, targets: positional(tokens) };
  if (!mode) return { mutating: false, targets: [] };
  const args = positional(tokens);
  if (mode === "last") return { mutating: true, targets: args.slice(-1) };
  if (mode === "first") return { mutating: true, targets: args.slice(0, 1) };
  if (mode === "second") return { mutating: true, targets: args.slice(1, 2) };
  if (mode === "rest") return { mutating: true, targets: args.slice(1) };
  if (mode === "all") return { mutating: true, targets: args };
  if (mode === "dest") return { mutating: true, targets: [namedArg(tokens, ["-destination", "-dest"]) || args.slice(-1)[0]].filter(Boolean) };
  if (mode === "path") return { mutating: true, targets: [namedArg(tokens, ["-path", "-filepath", "-literalpath"]) || args[0]].filter(Boolean) };
  return { mutating: true, targets: [] };
}

export function checkShellCommand(cwd, command, { shellMode = "write", writePaths = [], denyPaths = [], allowInlineScripts = false } = {}) {
  const text = String(command || "");
  if (!text.trim()) return { allowed: true };
  if (shellMode === "none") return { allowed: false, reason: "当前角色不允许执行 Shell 命令" };
  if (!allowInlineScripts && INLINE_SCRIPT_PATTERNS.some((re) => re.test(text))) {
    return { allowed: false, reason: "策略禁止内联脚本/动态执行（node -e、python -c、powershell -Command、Invoke-Expression 等），请把脚本写入允许的目录后通过受控命令执行" };
  }
  if (/[`]|\$\(/.test(text) && /[>]|\b(?:tee|Out-File|Set-Content|Add-Content)\b/i.test(text)) {
    return { allowed: false, reason: "策略禁止在写入命令中使用命令替换" };
  }
  if (shellMode === "readonly") {
    if (GIT_MUTATING.test(text)) return { allowed: false, reason: "只读角色不允许修改 Git 状态" };
    if (PACKAGE_MUTATING.test(text)) return { allowed: false, reason: "只读角色不允许安装或修改依赖" };
  }
  const segments = splitShellSegments(text);
  const writes = [];
  for (const segment of segments) {
    const tokens = tokenizeShell(stripRedirects(segment));
    const mutation = mutationTargets(tokens);
    if (mutation.mutating && shellMode === "readonly" && String(tokens[0]).toLowerCase() !== "tee") {
      return { allowed: false, reason: `只读角色不允许执行改写类命令：${tokens[0]}` };
    }
    if (mutation.mutating && mutation.targets.length === 0) {
      return { allowed: false, reason: `无法确定 ${tokens[0]} 的写入目标，已拒绝` };
    }
    writes.push(...mutation.targets, ...redirectTargets(segment));
  }
  if (!writes.length) return { allowed: true };
  if (CHANGE_DIR_PATTERN.test(text)) {
    return { allowed: false, reason: "写入类命令中不允许切换目录，请使用相对仓库根目录的路径" };
  }
  for (const target of writes) {
    if (/[*?$%~]/.test(target)) return { allowed: false, reason: `写入目标 ${target} 含通配符或变量，无法校验` };
    const check = checkWriteAllowed(cwd, target, { writePaths, denyPaths });
    if (!check.allowed) return { allowed: false, reason: `Shell 写入被拒绝：${check.reason}` };
    if (!writePaths.length) return { allowed: false, reason: "当前角色没有可写目录，Shell 写入被拒绝" };
  }
  return { allowed: true };
}
