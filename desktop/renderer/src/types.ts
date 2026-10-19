// 渲染进程共享类型：网关推送的任务/事件结构，以及 preload 暴露的 window.desktop 接口。
export type Task = {
  task_id?: string;
  project_name?: string | null;
  title?: string;
  description?: string;
  // 任务的负责角色：项目经理发起为 project_manager，桌面端“单独交给”某个机器人时为该角色。
  agent?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
  status_snapshot?: {
    status?: string;
    latest_event?: string;
    updated_at?: string;
    quality_gates?: {
      implementation?: string;
      self_test?: string;
      independent_acceptance?: string;
      audit?: string;
      product?: string;
    };
  };
};
export type EventRecord = {
  event_id?: string;
  type?: string;
  task_id?: string;
  sub_task_id?: string;
  parent_task_id?: string;
  assignment_id?: string;
  agent?: string;
  agent_name?: string;
  target?: string;
  from?: string;
  project_name?: string;
  timestamp?: string;
  title?: string;
  summary?: string;
  text?: string;
  error?: string;
  tool?: string;
  command?: string;
  file_path?: string;
  artifact_count?: number;
  artifact_paths?: string[];
  aggregate_delivery_count?: number;
  aggregate_agent_count?: number;
  aggregate_acceptance_count?: number;
  aggregate_acceptance_passed?: number;
  tool_call_id?: string;
  run_id?: string;
  artifact_items?: Array<{ path?: string; description?: string; type?: string; size?: number }>;
  status?: string;
  final?: boolean;
  assigned_task?: string;
  next?: string;
  blockers?: string[];
  risks?: string[];
  agents?: string[];
  assignments?: Array<{ agentKey?: string; task?: string; reason?: string }>;
  verdict?: "pass" | "fail" | "skip";
  checks?: Array<{ id?: string; title?: string; status?: string; detail?: string }>;
  evidence?: Array<{ kind?: string; command?: string; status?: string; exitCode?: number; path?: string; text?: string; url?: string }>;
  failed_checks?: string[];
  skip_reason?: string | null;
  targets?: string[];
  detail?: string;
};
export type Agent = { key: string; displayName?: string; enabled?: boolean };
export type DesktopMessage = {
  type: string;
  command?: string;
  tasks?: Task[];
  projects?: string[];
  agents?: Agent[];
  project?: string | null;
  event?: EventRecord;
  events?: EventRecord[];
  requestId?: string | null;
  result?: { taskId?: string; events?: EventRecord[]; projectName?: string; storagePath?: string; title?: string; retried?: boolean; resumed?: number; attempt?: number; status?: string; outputFile?: string; archived?: number; restored?: number; [key: string]: unknown };
  error?: string;
};
export type DesktopSocket = {
  send: (value: unknown) => void;
  subscribe: (listener: (message: DesktopMessage) => void) => () => void;
  close: () => void;
};
export type WorkspaceView = "conversation" | "project" | "settings" | "tickets" | "capabilities";
export type TicketSource = {
  id: string;
  repo: string;
  project: string;
  labels: string[];
  assignee: string;
  autoClose: boolean;
  pull: { enabled: boolean; everyHours: number; threshold: "severe" | "major" | "all"; confirmInFeishu: boolean; chatId: string; nextRunAt?: string | null; lastRunAt?: string | null; lastResult?: string };
};
export type Ticket = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  priority: { rank: number; label: string };
  status: string;
  taskId?: string | null;
};
// 输入框下方的模式切换：执行模式、协作对象（team 或某个角色）、运行方式（空字符串 = 沿用运行设置）。
export type TaskModes = { mode: "ask" | "plan" | "auto"; target: string; runtime: "" | "embedded" | "rpc" };
export type PendingSubmission = { projectName: string; title: string; description: string } & Partial<TaskModes>;
export type ControlCommand = "pause" | "resume" | "terminate" | "retry";

export type ToolExecution = {
  tool: string;
  events: EventRecord[];
};
export type AgentExecutionItem =
  | { kind: "event"; event: EventRecord }
  | { kind: "tool"; execution: ToolExecution };
export type AgentExecutionGroup = {
  key: string;
  agentKey: string;
  executionId: string;
  turn: number;
  displayName: string;
  events: EventRecord[];
  items: AgentExecutionItem[];
  status: string;
  assignedTask: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number | null;
  toolCount: number;
  fileCount: number;
  testCount: number;
  testFailed: boolean;
  finalResult?: EventRecord;
};
export type RuntimeModelChoice = { id: string; name: string; reasoning: boolean; contextWindow?: number | null };
export type RuntimeProviderChoice = { id: string; name: string; modelCount: number };
export type RuntimeThinkingChoice = { value: string; label: string };
export type RuntimeConfig = {
  provider: string;
  model: string;
  thinking: string;
  listingProvider: string;
  providers: RuntimeProviderChoice[];
  models: RuntimeModelChoice[];
  thinkingLevels: RuntimeThinkingChoice[];
};

export type CredentialStatus = { encryptionAvailable: boolean; keys: Array<{ key: string; readable: boolean }> };

export type SettingsFieldType = "text" | "path" | "number" | "select" | "boolean" | "roles" | "secret";
export type SettingsField = {
  key: string;
  label: string;
  type: SettingsFieldType;
  description?: string;
  placeholder?: string;
  default?: string;
  options?: Array<[string, string]>;
  allowCustom?: boolean;
  trueValue?: string;
  falseValue?: string;
  min?: number;
  advanced?: boolean;
  managed?: boolean;
  managedDefault?: boolean;
  role?: string;
  provider?: string;
  providers?: string[];
};
export type SettingsGroup = { id: string; title: string; description?: string; fields: SettingsField[] };
export type SettingsEntry = {
  value?: string;
  effective?: string;
  source: string;
  configured?: boolean;
  readable?: boolean;
  fromSystemEnv?: boolean;
};
export type SettingsSnapshot = { groups: SettingsGroup[]; entries: Record<string, SettingsEntry>; encryptionAvailable: boolean };

declare global {
  interface Window {
    desktop?: {
      connect: (project?: string) => Promise<DesktopSocket>;
      credentials?: {
        list: () => Promise<string[]>;
        status?: () => Promise<CredentialStatus>;
        set: (key: string, value: string) => Promise<unknown>;
        remove?: (key: string) => Promise<unknown>;
      };
      settings?: {
        get: () => Promise<SettingsSnapshot>;
        save: (changes: Record<string, string>) => Promise<SettingsSnapshot>;
      };
      restartGateway?: () => Promise<{ restarted: boolean }>;
      selectDirectory?: () => Promise<string>;
      openFile?: (filePath: string, projectName?: string) => Promise<{ opened: boolean; error?: string }>;
      quit?: () => Promise<unknown>;
    };
  }
}
