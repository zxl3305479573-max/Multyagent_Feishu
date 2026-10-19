// @ts-check
// 桌面端输入框下方的模式切换：
// - 执行模式 mode：ask 问答（只读回答，不派发、不改文件）/ plan 规划（派发或执行前等用户确认）/ auto 自动（直接执行）
// - 协作对象 target：team 由项目经理组织团队 / 某个角色 key（单独交给该机器人处理，不再派发其他角色）
// - 运行方式 runtime：embedded 进程内 / rpc 独立子进程；整条任务链（含派发出去的角色）都沿用同一种

export const EXECUTION_MODES = ["ask", "plan", "auto"];
export const RUNTIMES = ["embedded", "rpc"];

/** 问答模式只允许读取类工具和交付工具：写文件、执行命令、受控 CLI 一律由策略闸门拦下。 */
export const ASK_TOOL_ALLOWLIST = ["read", "grep", "find", "ls", "deliver_artifact", "get_task_status", "create_project"];

/**
 * @param {{ mode?: unknown, target?: unknown, runtime?: unknown }} [input]
 * @param {{ roleKeys?: string[] }} [options]
 * @returns {{ mode: "ask" | "plan" | "auto", target: string, runtime: "embedded" | "rpc" | null }}
 */
export function normalizeModes(input = {}, { roleKeys = [] } = {}) {
  const mode = EXECUTION_MODES.includes(String(input.mode)) ? /** @type {"ask" | "plan" | "auto"} */ (String(input.mode)) : "auto";
  const requested = String(input.target || "team");
  const target = requested !== "team" && requested !== "project_manager" && roleKeys.includes(requested) ? requested : "team";
  const runtime = RUNTIMES.includes(String(input.runtime)) ? /** @type {"embedded" | "rpc"} */ (String(input.runtime)) : null;
  return { mode, target, runtime };
}

/** 给 Agent 的模式说明，拼在任务提示词末尾。 @param {string} mode @param {boolean} singleRole */
export function modeInstruction(mode, singleRole) {
  if (mode === "ask") return "【问答模式】只回答用户的问题：可以读取文件和项目上下文，但不要修改任何文件、不要执行命令、不要派发其他角色（assignments 留空）。回答完毕调用 deliver_artifact 交付，并设置 final=true。";
  if (mode === "plan") {
    return singleRole
      ? "【规划模式】先只读分析并给出执行方案（要改哪些文件、怎么改、如何验证），不要修改文件。把方案写进交付摘要，next 写“按上述方案执行”。用户确认后你会再次被调用来执行。"
      : "【规划模式】先给出分阶段计划和 assignments；派发前用户会在桌面端确认，所以请把每个角色的任务、理由和验收标准写清楚。";
  }
  return singleRole ? "【单独处理】这项工作只交给你一个人完成，不要派发其他角色；完成后调用 deliver_artifact 交付，并设置 final=true。" : "";
}

/** 问答模式下的交付一律视为最终回答：清掉派发、计划与选项。 @param {any} delivery @param {string} mode */
export function applyModeToDelivery(delivery, mode) {
  if (mode !== "ask" || !delivery) return delivery;
  return { ...delivery, assignments: [], plan: null, choices: [], next: "", final: true };
}
