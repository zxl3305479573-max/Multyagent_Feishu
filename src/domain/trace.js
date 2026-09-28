const TEXT = 1;
const DATE_TIME = 5;

export const TRACE_FIELD_SCHEMA = [
  { name: "事件编号", type: TEXT, ui_type: "Text" },
  { name: "时间", type: DATE_TIME, ui_type: "DateTime" },
  { name: "精确时间", type: TEXT, ui_type: "Text" },
  { name: "任务编号", type: TEXT, ui_type: "Text" },
  { name: "子任务编号", type: TEXT, ui_type: "Text" },
  { name: "Agent", type: TEXT, ui_type: "Text" },
  { name: "事件类型", type: TEXT, ui_type: "Text" },
  { name: "状态", type: TEXT, ui_type: "Text" },
  { name: "工具", type: TEXT, ui_type: "Text" },
  { name: "命令", type: TEXT, ui_type: "Text" },
  { name: "文件", type: TEXT, ui_type: "Text" },
  { name: "结果", type: TEXT, ui_type: "Text" },
  { name: "错误", type: TEXT, ui_type: "Text" },
  { name: "摘要", type: TEXT, ui_type: "Text" },
  { name: "父事件编号", type: TEXT, ui_type: "Text" },
  { name: "因果编号", type: TEXT, ui_type: "Text" },
  { name: "尝试次数", type: TEXT, ui_type: "Text" },
  { name: "耗时毫秒", type: TEXT, ui_type: "Text" },
  { name: "工具名称", type: TEXT, ui_type: "Text" },
  { name: "文件变更", type: TEXT, ui_type: "Text" },
  { name: "测试结果", type: TEXT, ui_type: "Text" },
];

export const TRACE_KEY_FIELD = "事件编号";

const SECRET_PATTERNS = [
  /(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\s*[:=]\s*["']?)[^\s&"']+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
];

export function redactTraceText(value) {
  let text = String(value ?? "").slice(0, 2000);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}

function clip(value, max = 500) {
  return redactTraceText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

export function sanitizeTraceEvent(event = {}) {
  const source = event.event || event;
  return {
    event_id: clip(source.event_id || source.id || "", 100),
    timestamp: clip(source.timestamp || "", 64),
    task_id: clip(source.task_id || source.parent_task_id || "", 200),
    parent_task_id: clip(source.parent_task_id || "", 200),
    agent: clip(source.agent || source.target || "", 100),
    type: clip(source.type || "", 100),
    status: clip(source.status || source.state || (source.is_error ? "failed" : ""), 100),
    tool: clip(source.tool || source.tool_name || "", 100),
    command: clip(source.command || "", 1000),
    file_path: clip(source.file_path || "", 1000),
    result: clip(source.result_summary || source.outcome || "", 500),
    error: clip(source.error || "", 1000),
    summary: clip(source.summary || source.assigned_task || source.reason || source.current_action || "", 1000),
    parent_event_id: clip(source.parent_event_id || "", 100),
    causation_id: clip(source.causation_id || "", 100),
    attempt: Number.isFinite(Number(source.attempt)) ? Number(source.attempt) : null,
    duration_ms: Number.isFinite(Number(source.duration_ms)) ? Number(source.duration_ms) : null,
    tool_name: clip(source.tool_name || source.tool || "", 100),
    file_changes: Array.isArray(source.file_changes) ? source.file_changes.map((item) => clip(item, 500)).slice(0, 50) : [],
    test_result: source.test_result && typeof source.test_result === "object" ? source.test_result : null,
  };
}

export function toTraceFields(input = {}) {
  const event = sanitizeTraceEvent(input);
  const epoch = Date.parse(event.timestamp);
  return {
    "事件编号": event.event_id,
    "精确时间": event.timestamp,
    "任务编号": event.task_id.split(":")[0],
    "子任务编号": event.task_id.includes(":") ? event.task_id : event.parent_task_id,
    Agent: event.agent,
    "事件类型": event.type,
    "状态": event.status,
    "工具": event.tool,
    "命令": event.command,
    "文件": event.file_path,
    "结果": event.result,
    "错误": event.error,
    "摘要": event.summary,
    "父事件编号": event.parent_event_id,
    "因果编号": event.causation_id,
    "尝试次数": event.attempt === null ? "" : String(event.attempt),
    "耗时毫秒": event.duration_ms === null ? "" : String(event.duration_ms),
    "工具名称": event.tool_name,
    "文件变更": event.file_changes.length ? JSON.stringify(event.file_changes) : "",
    "测试结果": event.test_result ? JSON.stringify(event.test_result) : "",
    ...(Number.isNaN(epoch) ? {} : { "时间": epoch }),
  };
}
