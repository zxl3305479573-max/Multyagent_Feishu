// Pure projection logic for the Feishu Bitable task board.
// No SDK and no filesystem access here so the mapping stays unit-testable.

const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;
const DATE_TIME = 5;

export const BOARD_FIELD_SCHEMA = [
  { name: "任务", type: TEXT, ui_type: "Text" },
  { name: "任务编号", type: TEXT, ui_type: "Text" },
  { name: "项目", type: TEXT, ui_type: "Text" },
  { name: "负责人", type: TEXT, ui_type: "Text" },
  { name: "状态", type: TEXT, ui_type: "Text" },
  { name: "进度", type: NUMBER, ui_type: "Progress", property: { min: 0, max: 100, range_customize: true } },
  { name: "阶段", type: TEXT, ui_type: "Text" },
  { name: "执行角色", type: TEXT, ui_type: "Text" },
  { name: "控制指令", type: SINGLE_SELECT, ui_type: "SingleSelect", property: { options: [
    { name: "暂停", color: 5 },
    { name: "继续", color: 2 },
    { name: "终止", color: 1 },
  ] } },
  { name: "控制结果", type: TEXT, ui_type: "Text" },
  { name: "当前动作", type: TEXT, ui_type: "Text" },
  { name: "阻塞", type: TEXT, ui_type: "Text" },
  { name: "风险", type: TEXT, ui_type: "Text" },
  { name: "交付物", type: TEXT, ui_type: "Text" },
  { name: "开始时间", type: DATE_TIME, ui_type: "DateTime" },
  { name: "更新时间", type: DATE_TIME, ui_type: "DateTime" },
  // Text mirror keeps the exact second visible in Kanban cards; Feishu's
  // DateTime renderer may intentionally collapse a value to date-only.
  { name: "精确更新时间", type: TEXT, ui_type: "Text" },
  { name: "完成时间", type: DATE_TIME, ui_type: "DateTime" },
];

// The board is what a human reads, so values are Chinese even though events
// and logs stay in English keys.
export const STATUS_LABELS = {
  received: "待开始",
  in_progress: "执行中",
  awaiting_approval: "待确认",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  terminated: "已终止",
};

// Mirrors the display names in config/agents.json; test/bitable-labels.test.js
// fails if the two drift apart.
export const OWNER_LABELS = {
  project_manager: "项目经理",
  architect: "架构设计师",
  frontend_developer: "前端开发",
  backend_developer: "后端开发",
  tester: "测试",
  auditor: "审计",
};

export const STAGE_LABELS = {
  task_created: "已接单",
  task_reused: "继续处理",
  task_started: "开始执行",
  card_action_resolved: "人工已确认",
  delivery_received: "已交付",
  approval_required: "等待确认",
  dispatch_started: "已派发",
  dispatch_completed: "下游完成",
  task_completed: "本轮完成",
  task_settle: "任务结束",
  task_hold: "已暂停",
  task_failed: "执行失败",
  dispatch_failed: "派发失败",
  selection_failed: "选择处理失败",
  continuation_failed: "续跑失败",
  task_plan_created: "已生成计划",
  task_progress: "执行进度更新",
  control_applied: "控制指令已执行",
  task_terminated: "已终止",
  task_resumed: "已恢复",
  test_started: "测试中",
  test_result: "测试完成",
  file_change: "文件已变更",
  tool_call: "调用工具",
  tool_result: "工具已返回",
  agent_started: "执行中",
  agent_finished: "本轮结束",
};

export const TITLE_MAX_LENGTH = 120;

// Column the sync service uses to find an existing row for a task.
export const KEY_FIELD = "任务编号";

const FAILURE_EVENTS = new Set(["task_failed", "dispatch_failed", "selection_failed", "continuation_failed"]);

export function initialBoardState(taskId) {
  return {
    task_id: taskId,
    title: "",
    project_id: null,
    owner_agent: null,
    stage: null,
    status: "not_found",
    priority: null,
    progress: null,
    depends_on: [],
    current_action: null,
    blockers: [],
    risks: [],
    input_artifacts: [],
    output_artifacts: [],
    attempt: 0,
    started_at: null,
    updated_at: null,
    completed_at: null,
    error: null,
    chat_id: null,
    progress: null,
    planned_agents: [],
    completed_agents: [],
    active_agents: [],
    control_result: null,
  };
}

// Subtask ids are "<root>:<role>"; the board keeps one row per root task.
export function rootTaskIdFor(event = {}) {
  const candidate = event.task_id || event.parent_task_id || null;
  if (!candidate) return null;
  return String(candidate).split(":")[0];
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function clip(value, max = TITLE_MAX_LENGTH) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function compactAction(value) {
  const text = clip(value, 160)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s*/g, "$1")
    .replace(/\b(?:workspace|runtime)\/[^\s]+/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, 160);
}

function withUpdate(state, event, patch) {
  return {
    ...state,
    ...patch,
    updated_at: event?.timestamp || state.updated_at,
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function progressFor(state) {
  if (state.status === "completed") return 100;
  if (!state.planned_agents.length) return state.progress;
  return Math.round((state.completed_agents.length / state.planned_agents.length) * 100);
}

export function reduceEvent(state, event = {}) {
  if (!state || !event.type) return state;
  const timestamp = event.timestamp || null;
  const agent = event.agent || event.target || null;

  // A terminal control decision is authoritative. Late tool/dispatch events
  // may still arrive while an active Pi turn is winding down, but they must
  // not make a terminated task appear active again on the board.
  if (state.status === "terminated" && !["control_applied", "task_terminated"].includes(event.type)) {
    return withUpdate(state, event, {});
  }

  switch (event.type) {
    case "task_created":
    case "task_reused":
      return withUpdate(state, event, {
        status: state.status === "not_found" ? "received" : state.status,
        owner_agent: agent || state.owner_agent,
        chat_id: event.chat_id || state.chat_id,
        title: state.title || clip(event.text),
        stage: event.type,
      });

    case "task_started":
      return withUpdate(state, event, {
        status: "in_progress",
        stage: "task_started",
        owner_agent: agent || state.owner_agent,
        chat_id: event.chat_id || state.chat_id,
        project_id: event.project_name || state.project_id,
        started_at: state.started_at || timestamp,
        current_action: "开始执行",
        active_agents: unique([...state.active_agents, ...(agent ? [agent] : [])]),
      });

    case "task_plan_created": {
      const planned = unique(Array.isArray(event.agents) ? event.agents : []);
      const next = withUpdate(state, event, {
        stage: "task_plan_created",
        planned_agents: planned,
        progress: planned.length ? 0 : state.progress,
        current_action: planned.length ? `已规划 ${planned.length} 个执行角色` : state.current_action,
      });
      return { ...next, progress: progressFor(next) };
    }

    case "task_progress":
      return withUpdate(state, event, {
        stage: "task_progress",
        progress: Number.isFinite(event.progress) ? Math.max(0, Math.min(100, Math.round(event.progress))) : state.progress,
        current_action: compactAction(event.current_action) || state.current_action,
      });

    case "card_action_resolved":
      return withUpdate(state, event, {
        stage: "card_action_resolved",
        current_action: `人工确认：${event.choice || "approve"}`,
      });

    case "delivery_received":
      return withUpdate(state, event, {
        stage: "delivery",
        owner_agent: agent || state.owner_agent,
        project_id: event.project_name || state.project_id,
        blockers: asList(event.blockers),
        risks: asList(event.risks),
        output_artifacts: asList(event.artifact_paths),
        current_action: compactAction(event.summary) || state.current_action,
      });

    case "approval_required":
      return withUpdate(state, event, {
        status: "awaiting_approval",
        stage: "approval_required",
        owner_agent: agent || state.owner_agent,
        project_id: event.project_name || state.project_id,
        current_action: "等待人工确认",
      });

    case "dispatch_started":
      {
        const next = withUpdate(state, event, {
          status: state.status === "awaiting_approval" || state.status === "not_found" ? "in_progress" : state.status,
          stage: "dispatch_started",
          owner_agent: agent || state.owner_agent,
          project_id: event.project_name || state.project_id,
          current_action: agent ? `派发给 ${agent}` : state.current_action,
          active_agents: unique([...state.active_agents, ...(agent ? [agent] : [])]),
        });
        return { ...next, progress: progressFor(next) };
      }

    case "dispatch_completed":
      {
        const next = withUpdate(state, event, {
          stage: "dispatch_completed",
          owner_agent: agent || state.owner_agent,
          current_action: agent ? `${agent} 已完成` : state.current_action,
          active_agents: state.active_agents.filter((item) => item !== agent),
          completed_agents: unique([...state.completed_agents, ...(agent ? [agent] : [])]),
        });
        return { ...next, progress: progressFor(next) };
      }

    case "dispatch_failed":
      return withUpdate(state, event, {
        status: "failed",
        stage: "dispatch_failed",
        owner_agent: agent || state.owner_agent,
        error: event.error || state.error,
        current_action: event.error ? compactAction(`失败：${event.error}`) : state.current_action,
        active_agents: state.active_agents.filter((item) => item !== agent),
      });

    case "control_applied":
      return withUpdate(state, event, {
        stage: "control_applied",
        control_result: compactAction(event.result || event.command || ""),
        current_action: compactAction(event.result || event.command || "") || state.current_action,
        status: event.command === "pause" ? "paused"
          : event.command === "resume" ? "in_progress"
            : event.command === "terminate" && state.status !== "not_found" ? "terminated"
              : state.status,
      });

    case "task_terminated":
      return withUpdate(state, event, {
        status: "terminated",
        stage: "task_terminated",
        current_action: "任务已终止",
        active_agents: [],
      });

    case "task_resumed":
      return withUpdate(state, event, {
        status: "in_progress",
        stage: "task_resumed",
        current_action: "任务已恢复",
      });

    case "test_started":
    case "test_result":
    case "file_change":
    case "tool_call":
    case "tool_result":
      return withUpdate(state, event, {
        stage: event.type,
        current_action: compactAction(event.command || event.file_path || event.summary) || state.current_action,
      });

    case "agent_started":
      return withUpdate(state, event, {
        status: state.status === "not_found" ? "in_progress" : state.status,
        owner_agent: agent || state.owner_agent,
        active_agents: unique([...state.active_agents, ...(agent ? [agent] : [])]),
        current_action: agent ? `${OWNER_LABELS[agent] || agent} 开始执行` : state.current_action,
      });

    case "agent_finished":
      return withUpdate(state, event, {
        active_agents: state.active_agents.filter((item) => item !== agent),
        current_action: agent ? `${OWNER_LABELS[agent] || agent} 本轮结束` : state.current_action,
      });

    case "task_completed":
      if (event.final === true) {
        const next = withUpdate(state, event, {
          status: "completed",
          stage: "task_completed",
          completed_at: timestamp || state.completed_at,
          current_action: "最终交付完成",
          active_agents: [],
        });
        return { ...next, progress: 100 };
      }
      return withUpdate(state, event, {
        stage: "task_completed",
        project_id: event.project_name || state.project_id,
      });

    case "task_settle":
      return withUpdate(state, event, {
        status: "completed",
        stage: "task_settle",
        completed_at: timestamp || state.completed_at,
        current_action: event.reason ? `结束：${event.reason}` : state.current_action,
        active_agents: [],
        progress: 100,
      });

    case "task_hold":
      return withUpdate(state, event, {
        status: "paused",
        stage: "task_hold",
        current_action: event.reason ? `暂停：${event.reason}` : "已暂停",
        active_agents: [],
      });

    default:
      if (FAILURE_EVENTS.has(event.type)) {
        return withUpdate(state, event, {
          status: "failed",
          stage: event.type,
          owner_agent: agent || state.owner_agent,
          error: event.error || state.error,
          current_action: event.error ? compactAction(`失败：${event.error}`) : state.current_action,
        });
      }
      return withUpdate(state, event, {});
  }
}

function joinList(value) {
  return asList(value).join("\n");
}

function toEpoch(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Feishu field payload. Absent timestamps are omitted so an unfinished task
// never shows a fabricated completion time.
export function toBitableFields(state) {
  const fields = {
    任务: state.title || "",
    任务编号: state.task_id,
    项目: state.project_id || "",
    当前动作: compactAction(state.current_action),
    "执行角色": unique(state.active_agents || []).map((key) => OWNER_LABELS[key] || key).join("、"),
    阻塞: joinList(state.blockers),
    风险: joinList(state.risks),
    交付物: joinList(state.output_artifacts),
  };

  if (state.owner_agent) fields.负责人 = OWNER_LABELS[state.owner_agent] ?? state.owner_agent;
  // "not_found" is an internal placeholder; writing it would fail now that the
  // column is a single select with a fixed option set.
  if (state.status && state.status !== "not_found") fields.状态 = STATUS_LABELS[state.status] ?? state.status;
  if (Number.isFinite(state.progress)) fields["进度"] = Math.max(0, Math.min(100, state.progress));
  if (state.control_result) fields["控制结果"] = state.control_result;
  if (state.stage) fields.阶段 = STAGE_LABELS[state.stage] ?? state.stage;

  const startedAt = toEpoch(state.started_at);
  const updatedAt = toEpoch(state.updated_at);
  const completedAt = toEpoch(state.completed_at);
  if (startedAt !== null) fields.开始时间 = startedAt;
  if (updatedAt !== null) fields.更新时间 = updatedAt;
  if (updatedAt !== null) fields["精确更新时间"] = formatExactTime(state.updated_at);
  if (completedAt !== null) fields.完成时间 = completedAt;

  return fields;
}

function formatExactTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
