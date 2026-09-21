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
];

// 判断命令是否为删除类操作。纯函数，便于测试。
export function isDeleteCommand(command) {
  return DELETE_PATTERNS.some((re) => re.test(String(command || "")));
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
