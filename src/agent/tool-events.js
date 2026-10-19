// 把 Pi 的工具执行事件映射为结构化 Trace 事件（只保留摘要字段，不含模型文本与工具输出）。
function testCommand(command = "") {
  return /(?:^|[\s;&|])(?:npm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|pnpm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|yarn\s+(?:run\s+)?(?:test|vitest|jest|playwright)|bun\s+(?:run\s+)?(?:test|vitest|jest|playwright)|node\s+--test|pytest|vitest|jest|playwright\s+test)(?:\s|$)/i.test(command);
}

function concise(value, max = 120) {
  return String(value ?? "")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\s*[=:]\s*)[^\s&"']+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** One short, user-facing description per tool invocation; never includes file contents or tool output. */
export function describeToolCall(toolName = "", args = {}) {
  const tool = String(toolName || "工具");
  const command = concise(args.command, 160);
  const path = concise(args.path || args.file_path || args.file, 160);
  const pattern = concise(args.pattern || args.query || args.glob, 120);
  if (["bash", "powershell"].includes(tool)) return command && testCommand(command) ? `运行测试：${command}` : `执行命令：${command || "未提供命令"}`;
  if (tool === "read") return `读取文件：${path || "未指定路径"}`;
  if (tool === "write") return `写入文件：${path || "未指定路径"}`;
  if (tool === "edit") return `编辑文件：${path || "未指定路径"}`;
  if (tool === "grep") return `搜索内容：${pattern || "未指定关键词"}`;
  if (["glob", "find"].includes(tool)) return `查找文件：${pattern || path || "未指定范围"}`;
  if (["ls", "list"].includes(tool)) return `查看目录：${path || "."}`;
  if (tool === "agent_cli") return `执行受控命令：${concise(args.action || args.command, 100) || "未指定操作"}`;
  if (tool === "deliver_artifact") return `提交交付：${concise(args.summary, 100) || "整理最终结果"}`;
  if (tool === "create_project") return `创建或切换项目：${concise(args.name || args.projectName, 80) || "未指定项目"}`;
  if (tool === "get_task_status") return `查询任务状态：${concise(args.taskId || args.task_id, 100) || "当前任务"}`;
  if (path) return `调用 ${tool}：${path}`;
  if (pattern) return `调用 ${tool}：${pattern}`;
  return `调用工具：${tool}`;
}

export function mapPiToolEvent(event = {}, context = {}, previous = {}) {
  const common = {
    task_id: context.taskId || null,
    parent_task_id: context.parentTaskId || null,
    agent: context.agentKey || null,
    ...(event.toolCallId ? { tool_call_id: event.toolCallId } : {}),
  };
  if (event.type === "agent_start") return [{ ...common, type: "agent_started", status: "running", summary: "Agent 开始执行" }];
  if (event.type === "agent_settled") {
    return [{ ...common, type: "agent_finished", status: "completed", summary: "Agent 执行轮次结束" }];
  }
  if (event.type === "tool_execution_start") {
    const args = event.args || {};
    const command = ["bash", "powershell"].includes(event.toolName) ? String(args.command || "") : "";
    const filePath = ["write", "edit"].includes(event.toolName) ? String(args.path || "") : "";
    const events = [{ ...common, type: "tool_call", status: "running", tool: event.toolName, ...(command ? { command } : {}), ...(filePath ? { file_path: filePath } : {}), summary: describeToolCall(event.toolName, args) }];
    if (command && testCommand(command)) events.push({ ...common, type: "test_started", status: "running", tool: event.toolName, command, summary: "测试开始" });
    return events;
  }
  if (event.type === "tool_execution_end") {
    const failed = event.isError === true;
    const command = String(previous.command || "");
    const description = describeToolCall(event.toolName, previous);
    const events = [{ ...common, type: "tool_result", status: failed ? "failed" : "completed", tool: event.toolName, summary: `${description}${failed ? "（失败）" : "（完成）"}` }];
    if (["write", "edit"].includes(event.toolName) && !failed && previous.path) {
      events.push({ ...common, type: "file_change", status: "completed", tool: event.toolName, file_path: String(previous.path), summary: event.toolName === "write" ? "文件已创建或覆盖" : "文件已编辑" });
    }
    if (command && testCommand(command)) events.push({ ...common, type: "test_result", status: failed ? "failed" : "passed", tool: event.toolName, command, summary: failed ? "测试命令失败" : "测试命令完成" });
    if (failed) events.push({ ...common, type: "error", status: "failed", tool: event.toolName, summary: "工具调用失败", error: "工具返回错误" });
    return events;
  }
  return [];
}
