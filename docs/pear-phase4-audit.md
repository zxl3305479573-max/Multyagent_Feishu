# Pear 阶段二/三/四能力审计

审计范围：`feat/pear-layout-unified` 分支现有代码。原则是只读复用真实任务、事件和配置数据；没有后端数据的能力明确显示空状态，不生成示例数据，也不修改 Agent 运行时或网关任务协议。

## 阶段二：Agent 核心能力

| 能力 | 结论 | 现有实现 | 缺口 |
| --- | --- | --- | --- |
| 模型接入 | covered | `src/model-config.js` 负责模型配置、运行时切换与 `models.json`；`src/pi-agent.js` 用 `selectedModel()` 和 `createAgentSession()` 启动 Pi；桌面端通过 `runtime_config` / `runtime_config_set` 读取和切换。 | 无关键缺口；模型凭据仍依赖现有运行设置与 Pi 配置。 |
| 流式输出 | partial | `src/pi-agent.js:211` 和 `src/runtime/pi-rpc-runner.js:35` 消费 Pi 的 `text_delta` 并累积文本；工具事件会即时映射为 Trace。 | 文本增量没有作为桌面事件逐 token 推送，渲染端目前只收到最终文本和结构化执行事件。 |
| Agent Loop | covered | `src/pi-agent.js:220` 调用 `session.prompt()`；`src/orchestrator.js` 负责交付、续跑、重试和派发；`src/desktop-task.js` 创建并推进桌面任务。 | 无关键缺口。 |
| Tool Calling | covered | `src/agent/tool-events.js` 把 Pi 工具执行映射为 `tool_call` / `tool_result` / 测试事件；`src/agent/policy-gate.js` 在调用前执行工具白名单、路径、Shell 和网络策略。 | 无关键缺口。 |
| MCP | missing | 当前没有 MCP Server 注册、配置存储、生命周期管理或桌面配置页。`docs/superpowers/specs/2026-09-14-pi-multiagent-feishu-architecture.md` 也明确记录了当前采用 Pi 扩展而不是 MCP。 | 需要新增 MCP 配置模型、连接管理、工具发现与权限映射；本阶段未伪造该能力。 |
| 任务状态同步 | covered | `src/domain/task-store.js` 持久化任务快照；`src/observability.js` 写入事件；`src/event-log.js` 流式读取日志；`src/desktop-control.js` 通过 WebSocket 下发 `ready`、`event` 和 `task_events`。 | 无关键缺口；桌面端只保留最近事件窗口，完整历史按任务读取。 |

## 阶段三：动态 IP 交互

- 角色状态：`desktop/renderer/src/themes/animation.ts` 定义 `idle`、`thinking`、`planning`、`executing`、`success`、`error`、`confirm`，静态图片适配器从皮肤素材取图，Rive/Lottie 仅保留适配器入口。
- 任务过程可视化：`desktop/renderer/src/task-timeline.ts` 从现有 `task_plan_created`、`plan_progress`、`tool_call`、`tool_result`、`approval_required`、`task_failed` 等事件生成步骤时间线和进度；`TaskPanel` 同时展示真实工具调用数与最近日志。
- 异常与确认：失败状态使用统一 `ErrorCard`，重试调用现有 `retry` 命令；等待确认使用 `ApprovalCard`，确认或明确选项调用现有 `approve_task`。现有 `orchestrator.resolveLatest()` 没有独立的通用“驳回”动作，因此界面不会伪造驳回；只有后端交付中明确给出的选项才会作为按钮出现。

## 阶段四：页面数据源

| 页面 | 现有实现 | 真实数据 / IPC | 尚缺后端能力 |
| --- | --- | --- | --- |
| 记忆中心 | `desktop/renderer/src/components/MemoryCenterView.tsx` | `memory_list` → `src/desktop-host.js` → `TaskStore.list()` 的 `conversation_memory`；数据由 `src/desktop-task.js` 在任务执行和续聊时写入。 | 独立记忆存储、编辑/删除、用户确认事实与模型推断分类、项目级长期记忆。当前页面为只读。 |
| 技能中心 | 复用 `desktop/renderer/src/components/CapabilitiesView.tsx` | `capabilities_list`、`capabilities_install`、`capabilities_assign`、`capabilities_base_assign`、`capabilities_remove` → `src/capabilities/registry.js`；基础工具与 Skill/插件均为真实配置。 | MCP Server、技能使用记录、统一技能市场；当前技能/插件能力已可管理。 |
| 文件管理 | `desktop/renderer/src/components/FileManagerView.tsx` | `workspace_files` → `src/desktop-host.js` 流式读取 `events.jsonl` 的 `file_path`、`artifact_paths`、`artifact_items`、验收证据路径；打开文件走既有 `desktop:open-file`。 | 上传、删除、目录浏览和完整工作区文件 API；当前仅展示任务事件中出现的文件引用。 |
| 任务历史 | `desktop/renderer/src/components/TaskHistoryView.tsx` | WebSocket `ready` 快照中的 `tasks`（`TaskStore.list()`）；点击任务后读取 `task_events`（`src/desktop-control.js` + `src/event-log.js`）。 | 服务端分页、跨项目筛选和独立历史查询 API；导出/归档仍复用项目上下文页的既有命令。 |
| 权限管理 | `desktop/renderer/src/components/PermissionsView.tsx` | `capabilities_list` 提供基础工具开关；`custom_agents_list` → `src/custom-roles.cjs` 提供自定义 Agent 的工具、目录、Shell、网络与并发边界；等待确认任务来自真实任务快照。 | 独立权限中心、统一权限审计日志和可在此页直接授权的后端接口；当前页面只读，修改入口在技能中心/自定义 Agent。 |
| 运行监控 | `desktop/renderer/src/components/RuntimeMonitorView.tsx` | `desktop:gateway:status`（`desktop/electron/main.cjs`）读取 token 文件并请求 `/health`；任务状态来自 `TaskStore`，事件来自 WebSocket，模型来自 `runtime_config`。 | CPU、内存、Token 用量、持久化指标与日志检索；当前页面只展示已有健康检查、任务状态和事件窗口。 |

## 结论

阶段四页面均已接入现有真实数据源。记忆、文件和权限保持只读，并在页面内明确说明缺失的后端能力；技能中心复用现有能力管理，任务历史复用任务库和事件日志，运行监控复用网关健康检查与任务事件。没有为缺失能力生成假数据。
