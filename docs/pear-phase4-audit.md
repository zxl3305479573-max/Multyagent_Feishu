# Pear 阶段二/四能力审计

审计原则：只使用真实任务、事件和本地配置；没有后端数据时显示空状态，不生成示例指标或假数据。

## 阶段二：Agent 核心能力

| 能力 | 状态 | 已覆盖 | 剩余缺口 |
| --- | --- | --- | --- |
| 模型接入 | covered | `model-config.js`、Pi session 和运行设置 | 无关键缺口 |
| 流式输出 | covered | Pi `text_delta` 映射为 `assistant_text_delta`，桌面端按任务轮次实时拼接，`assistant_text` 保留最终结果 | Markdown 仍按纯文本增量渲染，未引入完整 Markdown 增量 AST |
| Agent Loop | covered | 现有 orchestrator、任务续聊、重试和派发 | 无关键缺口 |
| Tool Calling | covered | 现有 Pi 工具、事件映射和策略闸门 | 无关键缺口 |
| MCP | partial | 本地 JSON 配置、stdio 生命周期、工具发现、角色分配、Pi 调用和 policy gate | 暂无 SSE/OAuth/marketplace；异常后的自动重连需后续补充 |
| 任务状态同步 | covered | TaskStore、events.jsonl、桌面 WebSocket ready/event/task_events | 无关键缺口 |

## 阶段四：页面数据源

| 页面 | 状态 | 已覆盖 | 剩余缺口 |
| --- | --- | --- | --- |
| 记忆中心 | covered | `memory_list` 读取任务记忆；`memory_update` 编辑/确认；`memory_delete` 删除；写回 TaskStore | 仍是任务级记忆，不是独立跨项目知识库 |
| 技能中心 | partial | 现有 Skill/插件管理；MCP server 添加、启停、重连、删除、工具发现和来源展示 | MCP 工具使用统计尚未持久化 |
| 文件管理 | covered | 事件文件列表 + 已登记项目根目录真实遍历；打开仍走 `desktop:open-file` | 无上传/删除；外部目录仅能通过项目登记配置进入 |
| 任务历史 | covered | TaskStore 快照和完整 task_events | 无独立服务端分页查询/归档导出 API |
| 权限管理 | covered | 基础工具开关可直接修改；自定义 Agent 启用状态可直接修改；详细工具/目录/Shell/网络边界复用编辑器保存校验 | 不是独立授权系统，没有新增身份认证层 |
| 运行监控 | covered | 网关健康、PID、启动时间、当前模型、任务状态、真实最近事件和异常 | 不采集 CPU、内存、Token 图表；这些数据当前不存在 |

## 交付范围

- 已实现：真实 Pi 流式文本桌面推送、最小 MCP、记忆读写、项目目录浏览、权限读写、技能中心 MCP 展示。
- 保持不变：Agent loop、编排协议、审批和任务状态语义；仅增加流式事件和 MCP 工具接入。
