// 策略闸门：Pi 会话每次调用工具前都会经过这里。
// 依次检查任务级工具白名单、敏感文件、删除命令、联网、Shell 写入与 write/edit 落点。
import { checkNetworkAllowed, checkShellCommand, checkWriteAllowed, isDeleteCommand, resolveWritePaths } from "../policy.js";
import { isAbsolute, relative, resolve } from "node:path";
import { roleConfig } from "../role-config.cjs";
import { getCapabilityRegistry } from "../capabilities/index.js";

// 分配给该角色的 Skill 目录始终可读：任务级读取白名单只约束项目文件，不能让 Agent 读不到自己的 Skill。
function insideAssignedSkill(agentKey, cwd, requested) {
  if (!requested) return false;
  const target = resolve(cwd || process.cwd(), requested);
  return getCapabilityRegistry().forRole(agentKey).skillPaths.some((dir) => {
    const inside = relative(dir, target);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  });
}

const { policy } = roleConfig();

// 敏感路径/命令拦截。命中即阻断工具执行。
export const SENSITIVE_PATTERNS = [
  /\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /auth\.json/i,
  /models-store\.json/i,
  /\.git\/config/i,
];

// 每个角色一个策略工厂：闭包捕获该角色的写路径白名单/黑名单。
export function createPolicyFactory(agent, projectNameOrGetter, taskPermissionsGetter = null) {
  const cfg = policy.agents?.[agent.key] ?? {};
  const getProjectName = typeof projectNameOrGetter === "function"
    ? projectNameOrGetter
    : () => projectNameOrGetter;
  // denyPaths 同样可以包含 {project} 占位符（例如禁止前端角色写 workspace/{project}/backend）。
  const denyPathsFor = (project) => resolveWritePaths(cfg.denyPaths || [], project);
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const taskPermissions = typeof taskPermissionsGetter === "function" ? (taskPermissionsGetter() || {}) : {};
      if (Array.isArray(taskPermissions.toolAllowlist) && taskPermissions.toolAllowlist.length && !taskPermissions.toolAllowlist.includes(event.toolName)) {
        return { block: true, reason: `当前任务白名单不允许工具：${event.toolName}` };
      }
      // 1. 敏感文件拦截（全局，所有工具）
      const raw = [event.input?.path, event.input?.command, event.input?.pattern]
        .filter(Boolean)
        .join(" ");
      if (SENSITIVE_PATTERNS.some((re) => re.test(raw))) {
        return { block: true, reason: "策略禁止访问敏感文件或执行敏感命令" };
      }
      // 2. 删除类命令拦截（仅允许创建与写入）。
      if (event.toolName === "bash" || event.toolName === "powershell") {
        if (isDeleteCommand(event.input?.command)) {
          return { block: true, reason: "策略禁止删除操作（仅允许创建与写入）" };
        }
      }
      // 3. 写入路径拦截（write/edit）
      if (event.toolName === "bash" || event.toolName === "powershell") {
        const roleNetwork = { enabled: cfg.networkAccess === true, domains: cfg.networkDomains || [] };
        const networkPolicy = taskPermissions.networkPolicy && typeof taskPermissions.networkPolicy === "object" ? taskPermissions.networkPolicy : roleNetwork;
        const network = checkNetworkAllowed(event.input?.command, networkPolicy);
        if (!network.allowed) return { block: true, reason: `network policy denied command: ${network.reason}` };
        // bash 可以绕过 write/edit 的路径校验，这里对重定向、改写类命令和内联脚本单独把关。
        const currentProject = getProjectName();
        const shellOptions = {
          shellMode: cfg.shellMode || "readonly",
          writePaths: currentProject ? resolveWritePaths(cfg.writePaths, currentProject) : [],
          denyPaths: denyPathsFor(currentProject),
          allowInlineScripts: cfg.allowInlineScripts === true,
        };
        const shell = checkShellCommand(ctx.cwd, event.input?.command, shellOptions);
        if (!shell.allowed) return { block: true, reason: shell.reason };
        if (Array.isArray(taskPermissions.fileWriteAllowlist) && taskPermissions.fileWriteAllowlist.length) {
          const taskShell = checkShellCommand(ctx.cwd, event.input?.command, { ...shellOptions, writePaths: taskPermissions.fileWriteAllowlist });
          if (!taskShell.allowed) return { block: true, reason: `当前任务文件写入白名单拒绝：${taskShell.reason}` };
        }
      }
      if (event.toolName === "write" || event.toolName === "edit") {
        const currentProject = getProjectName();
        if (cfg.writePaths?.length && !currentProject) {
          return { block: true, reason: "尚未确定项目，禁止写入项目目录" };
        }
        const writePaths = resolveWritePaths(cfg.writePaths, currentProject);
        const denyPaths = denyPathsFor(currentProject);
        const check = checkWriteAllowed(ctx.cwd, event.input?.path, { writePaths, denyPaths });
        if (!check.allowed) {
          return { block: true, reason: check.reason };
        }
        if (Array.isArray(taskPermissions.fileWriteAllowlist) && taskPermissions.fileWriteAllowlist.length) {
          const taskCheck = checkWriteAllowed(ctx.cwd, event.input?.path, { writePaths: taskPermissions.fileWriteAllowlist, denyPaths });
          if (!taskCheck.allowed) return { block: true, reason: "当前任务文件写入白名单拒绝该路径" };
        }
      }
      if (["read", "grep", "find", "ls"].includes(event.toolName) && Array.isArray(taskPermissions.fileReadAllowlist) && taskPermissions.fileReadAllowlist.length
        && !insideAssignedSkill(agent.key, ctx?.cwd, event.input?.path)) {
        const requested = String(event.input?.path || event.input?.pattern || "");
        const normalized = requested.replaceAll("\\", "/");
        const allowed = taskPermissions.fileReadAllowlist.some((root) => {
          const base = String(root).replaceAll("\\", "/").replace(/\/$/, "");
          return normalized === base || normalized.startsWith(`${base}/`);
        });
        if (!allowed) return { block: true, reason: "当前任务文件读取白名单拒绝该路径" };
      }
    });
  };
}
