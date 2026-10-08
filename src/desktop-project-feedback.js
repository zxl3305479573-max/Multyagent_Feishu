export function formatProjectCommandFeedback(command, result = {}) {
  if (command === "export_project") {
    return `项目已导出：${result.outputFile || "已生成导出文件"} · ${Number(result.taskCount) || 0} 个任务 · ${Number(result.eventCount) || 0} 条事件`;
  }
  if (command === "cleanup_history") {
    return `历史已归档：归档 ${Number(result.archived) || 0} 条，保留 ${Number(result.kept) || 0} 条`;
  }
  if (command === "restore_history") {
    return `历史已恢复：恢复 ${Number(result.restored) || 0} 条记录`;
  }
  return "";
}
