// 把 Pi 的工具执行事件映射为结构化 Trace 事件（只保留摘要字段，不含模型文本与工具输出）。
function testCommand(command = "") {
  return /(?:^|[\s;&|])(?:npm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|pnpm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|yarn\s+(?:run\s+)?(?:test|vitest|jest|playwright)|bun\s+(?:run\s+)?(?:test|vitest|jest|playwright)|node\s+--test|pytest|vitest|jest|playwright\s+test)(?:\s|$)/i.test(command);
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
    const events = [{ ...common, type: "tool_call", status: "running", tool: event.toolName, ...(command ? { command } : {}), ...(filePath ? { file_path: filePath } : {}), summary: "工具开始执行" }];
    if (command && testCommand(command)) events.push({ ...common, type: "test_started", status: "running", tool: event.toolName, command, summary: "测试开始" });
    return events;
  }
  if (event.type === "tool_execution_end") {
    const failed = event.isError === true;
    const command = String(previous.command || "");
    const events = [{ ...common, type: "tool_result", status: failed ? "failed" : "completed", tool: event.toolName, summary: failed ? "工具执行失败" : "工具执行完成" }];
    if (["write", "edit"].includes(event.toolName) && !failed && previous.path) {
      events.push({ ...common, type: "file_change", status: "completed", tool: event.toolName, file_path: String(previous.path), summary: event.toolName === "write" ? "文件已创建或覆盖" : "文件已编辑" });
    }
    if (command && testCommand(command)) events.push({ ...common, type: "test_result", status: failed ? "failed" : "passed", tool: event.toolName, command, summary: failed ? "测试命令失败" : "测试命令完成" });
    if (failed) events.push({ ...common, type: "error", status: "failed", tool: event.toolName, summary: "工具调用失败", error: "工具返回错误" });
    return events;
  }
  return [];
}
