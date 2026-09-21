# MultyAgent 飞书协作系统实施计划

- 日期：2026-09-18
- 项目：MultyAgent Feishu
- 状态：T0 基线已验证，后续阶段待执行
- 参考：TabTin 多 Agent 协作思路、Pi Agent Runtime、飞书机器人长连接接入

本文档是后续实施的唯一基线。实际执行必须从 T0 开始，完成验证并记录证据后，才能进入 T1；不得跳过基线直接接入六个 Agent。

## 1. 项目目标

在飞书项目群中，为不同职责配置独立机器人，并让每个机器人连接到职责专属的 Pi Agent。

系统需要实现：

1. 用户在飞书群中 `@` 某个机器人。
2. 飞书接入层识别机器人身份和消息来源。
3. 编排层创建任务并分配给对应 Agent。
4. Agent 在独立会话和工作区中执行任务。
5. 工具调用经过权限策略校验。
6. Agent 生成结构化交接包和验证证据。
7. 编排层更新任务状态。
8. 原机器人将结果回复到飞书群。
9. 多 Agent 任务通过任务图和产物协作，不通过自由聊天协作。

## 2. 六个职责 Agent

| Agent | 职责 | 工作范围 |
| --- | --- | --- |
| `project_manager` | 需求拆解、任务规划、进度汇总 | 不直接修改业务代码 |
| `architect` | 架构设计、接口契约、数据模型 | 主要读取代码，写设计文档和契约 |
| `frontend_developer` | 页面、组件、前端交互 | 只能修改前端目录 |
| `backend_developer` | 接口、业务逻辑、数据模型 | 只能修改后端目录 |
| `tester` | 测试设计、测试执行、缺陷反馈 | 默认只读，不修改业务代码 |
| `auditor` | 安全、权限、依赖和质量审计 | 全程只读，不修复业务代码 |

六个 Agent 是六个平级 Root Session，不是项目经理的 SubAgent。每个 Agent 必须拥有独立的 Pi Session、Session 目录、工作目录、工具白名单、权限策略、任务预算、审计日志和飞书机器人身份。

## 3. 总体架构

```text
飞书项目群
    ↓
Feishu Gateway
    ├─ 长连接事件接收、验签和去重
    ├─ App ID 到角色映射
    └─ 原机器人身份回复
    ↓
Task Orchestrator
    ├─ 任务创建与状态机
    ├─ 任务依赖图、Agent 调度
    ├─ 重试、恢复和审批
    └─ Token 与并发预算
    ↓
Agent Runtime Adapter
    └─ Pi RPC 子进程
    ↓
Policy Layer
    ├─ 工具白名单、文件路径边界
    ├─ 命令拦截、风险分级
    └─ 审计记录
    ↓
Workspace and Artifact Store
    ├─ Git worktree、任务产物、接口契约
    └─ 测试报告、审计报告
    ↓
Observability
    ├─ 任务、会话、工具调用和 Token 日志
    └─ 飞书多维表格投影
```

## 4. 核心设计原则

### 4.1 飞书是交互入口，不是真实任务状态源

飞书负责接收消息、展示任务状态和结果、发起审批、展示任务看板。真实任务状态由编排层持久化，多维表格只是状态投影。

### 4.2 Agent 之间不直接通信

所有跨 Agent 协作必须经过编排层：`Agent A → 编排层 → Agent B`。编排层负责权限、依赖、产物版本、状态、超时、重试和审计校验。

### 4.3 Agent 通过产物协作

跨 Agent 只传递任务引用、产物引用、版本号、文件摘要、验证证据、阻塞原因和下一步动作，不传递无约束的完整聊天历史。

### 4.4 Prompt 不是权限边界

Prompt 只能描述职责，不能阻止越权工具调用。每次工具执行前必须检查工具、路径、任务归属、审批要求和预算，最后才允许执行或阻断。

## 5. 任务状态机

```text
received → classified → planned → waiting_approval → ready → running
                                                          ├─ blocked
                                                          ├─ failed
                                                          └─ succeeded → completed
```

补充状态：`cancelled`、`retrying`、`waiting_dependency`、`waiting_input`。

状态禁止任意跳转：`received` 不能直接到 `completed`；`running` 必须经过交付包校验才能到 `succeeded`；`failed` 必须经过重试或人工处理后才能继续。

## 6. 任务对象与预算

```json
{
  "task_id": "T-001",
  "project_id": "P-001",
  "parent_task_id": null,
  "source_message_id": "om_xxx",
  "source_chat_id": "oc_xxx",
  "requested_role": "frontend_developer",
  "title": "修改登录页样式",
  "description": "调整登录页布局和按钮状态",
  "status": "received",
  "priority": "normal",
  "depends_on": [],
  "input_artifacts": [],
  "acceptance_criteria": ["页面布局符合需求", "前端测试通过", "构建命令执行成功"],
  "attempt": 0,
  "max_attempts": 2,
  "token_budget": 18000,
  "max_turns": 8,
  "max_runtime_seconds": 900,
  "created_at": "2026-09-18T00:00:00Z",
  "updated_at": "2026-09-18T00:00:00Z"
}
```

每个任务还必须设置 `max_input_tokens: 12000`、`max_output_tokens: 6000`、`max_turns: 8`、`max_runtime_seconds: 900` 和 `max_attempts: 2`。超过预算应暂停任务，重试不能无限循环。

## 7. Agent 交接包

每个 Agent 完成任务后必须生成结构化交接包：

```json
{
  "task_id": "T-001",
  "agent": "frontend_developer",
  "status": "completed",
  "summary": "完成登录页样式调整",
  "artifacts": [{"path": "frontend/src/pages/Login.tsx", "type": "source", "digest": "sha256:...", "version": "commit:abc123"}],
  "evidence": [{"command": "npm test", "result": "passed"}],
  "blockers": [],
  "assumptions": [],
  "risks": [],
  "next_action": "交给测试 Agent 进行独立验证",
  "created_at": "2026-09-18T00:00:00Z"
}
```

交接包校验失败时，任务必须标记为 `blocked`，原机器人回复缺失信息，禁止直接派发下游 Agent。

## 8. 实施阶段、依赖、产物与验收

### T0：基线检查

检查 `npm test`、六个机器人连接、长连接事件、`im.message.receive_v1`、App ID 路由、消息去重、原机器人回复和当前 `runAgent()` 行为。产物为 `docs/implementation/baseline.md`。验收要求是测试结果、连接结果和已知问题均有记录，且未修改既有业务逻辑。

### T1：任务领域模型

产物：`src/domain/task.js`、`src/domain/task-state.js`、`src/domain/handoff.js`、`src/domain/task-store.js`、对应测试。实现任务对象、状态转换、非法状态阻断、幂等键、交接包 Schema 和校验。验收：重复消息不重复建任务，非法跳转失败，重启可恢复，缺少交接字段时不能调度。

### T2：Agent Registry 和 Profile

产物：`config/agent-registry.json`、`profiles/*.md`、`policies/*.json`。注册信息至少包含 `display_name`、`runtime`、`profile`、`policy`、`workspace`、`session_dir`、`max_concurrent_tasks`、`max_turns` 和 `max_runtime_seconds`。第一阶段先验证前端 Profile，其他角色复用模板后再单独验收。

### T3：Pi RPC Runner

产物：`src/runtime/pi-rpc-runner.js`、`src/runtime/agent-runner.js`、对应测试。必须启动 `pi --mode rpc`，为 Agent 设置独立 cwd 和 sessionDir，通过 stdin/stdout 传输 JSONL，使用 `agent_settled` 判断完成，支持超时终止、退出原因、Pi 事件日志、失败和恢复；不能只用 `turn_end` 判断完成。

### T4：前端权限策略

允许读取项目配置、前端源码、批准的契约和前端测试；允许写入 `frontend/**`、前端测试和任务产物；只允许前端测试、构建和只读检查命令。必须阻断后端、数据库、契约、`.env`、删除操作、任意 shell、权限策略和其他 Session 的修改，并记录越权审计日志。

### T5：Gateway 接入编排层

流程改为“解析角色 → 创建任务 → 回复已接收 → 异步调度 → 校验交接包 → 更新状态 → 原机器人回复结果”。接收事件不能被 Agent 阻塞；消息必须幂等；回帖失败可重试；超时可处理；任务 ID 和状态可查询。

### T6：产物管理

建议目录：

```text
runtime/
├─ tasks/       ├─ sessions/       ├─ workspaces/
├─ artifacts/T-001/
│  ├─ handoff.json  ├─ summary.md  ├─ changed-files.json  └─ evidence.json
└─ logs/
```

每个产物记录 `task_id`、`agent`、路径、创建时间、版本号、SHA-256、依赖产物和验证命令。

### T7：第一个端到端闭环

场景为用户 `@前端开发`，创建任务并收到确认，启动前端 Pi Agent，执行合法前端修改，尝试修改后端并被策略层阻断，完成合法修改，保存测试/构建证据，生成交接包，再由原机器人回复结果。验收要求覆盖任务 ID、完整状态变化、Pi 事件日志、越权阻断、Schema、证据、回帖和重启恢复。

## 9. 多 Agent 扩展阶段

前端闭环稳定后，再扩展“项目经理 → 架构设计师 → 前端+后端 → 测试 → 审计 → 集成 → 项目经理汇总”。扩展内容包括 DAG、任务租约、心跳、失败重试、断点恢复、Git worktree、契约冻结、审批卡片、测试回流、审计闸门和多维表格同步。

## 10. 并行开发和合并规则

前后端使用独立 worktree，例如 `runtime/workspaces/frontend/T-001` 和 `runtime/workspaces/backend/T-001`。文件 Owner 为：`frontend/**` → frontend，`backend/**` → backend，`contracts/**` → architect，`tests/**` → tester，`docs/**` → project_manager/architect。契约确认后任务才能进入 `ready`。

Agent 不自行合并；合并必须同时满足测试通过、审计通过、契约版本一致、无未解决冲突和交接包完整。

## 11. 审批边界

必须审批：修改接口契约或数据库结构、修改权限、删除或批量迁移、依赖版本变更、跨职责目录合并、生产发布，以及审计发现高危问题后继续执行。

可自动执行：阅读代码、修改负责目录、局部测试、设计文档、测试报告和交接包生成。

## 12. 多维表格和可观测性

多维表格只能由编排层统一写入，字段包括 `task_id`、`project_id`、`title`、`owner_agent`、`stage`、`status`、`priority`、`progress`、`depends_on`、`current_action`、`blocker`、`input_artifacts`、`output_artifacts`、`attempt`、`token_usage`、`started_at`、`updated_at`、`completed_at`。建议提供项目总览、Agent 状态、阻塞任务和已完成任务四个视图。

日志必须覆盖任务、Agent 会话、工具调用、Token 使用、状态迁移、交接校验和回帖结果；日志中不得记录密钥。

## 13. 风险与应对

| 风险 | 应对措施 |
| --- | --- |
| Prompt 无法限制权限 | 工具执行前策略拦截 |
| Agent 越权修改文件 | 工作区隔离、路径校验、审计日志 |
| 多 Agent 修改同一文件 | Owner、worktree、合并闸门 |
| 任务状态丢失 | 持久化状态库和事件日志 |
| 进程崩溃 | 心跳、租约、重试和断点恢复 |
| 消息重复执行 | `message_id` 幂等去重 |
| 交接不完整 | JSON Schema 校验 |
| Token 成本过高 | 摘要、上下文压缩和预算 |
| 审计被开发 Agent 自证 | 独立测试和审计 Session |
| 表格状态不一致 | 编排层作为唯一事实源 |

## 14. 当前状态与执行顺序

当前已验证或已有实现：六个角色配置、飞书长连接入口、`im.message.receive_v1`、App ID 路由、消息去重、原机器人身份回复、任务 JSON 持久化、基础编排、产物保存和权限路径函数。

仍需按验收标准补齐或强化：领域状态机约束、Agent Registry/Profile、Pi RPC Runner、工具级权限拦截、交接包 Schema、产物元数据、worktree、完整 DAG、测试/审计闸门、多维表格同步和端到端闭环。

严格顺序：

```text
T0 基线检查 → T1 任务模型 → T2 Agent Profile → T3 Pi RPC Runner
→ T4 权限策略 → T5 Gateway 编排 → T6 交接包/产物
→ T7 前端闭环 → T8 项目经理/架构 → T9 前后端并行
→ T10 测试/审计 → T11 Git 合并闸门 → T12 多维表格/飞书卡片
```

每阶段必须有代码或文档产物、自动化测试、失败场景验证、可追踪日志/证据，并且不影响前一阶段功能。

## 15. 第一阶段完成定义

只有同时满足以下条件，才认为第一阶段完成：

- 前端 Agent 可被飞书机器人触发。
- 任务可持久化，服务重启后状态不丢失。
- Pi RPC 可正常启动和结束。
- 前端 Agent 只能修改授权目录。
- 越权工具调用会被阻断并记录。
- Agent 可生成并通过结构化交接包校验。
- 测试和构建证据可保存。
- 原飞书机器人可回复最终结果。
- `npm test` 和新增测试全部通过。

## 16. T0 验证记录（2026-09-18）

- `npm test`：通过，51 个测试、0 失败、0 跳过。
- `npm start`：在当前本地 `.env` 凭据存在时，六个角色均成功初始化长连接并输出 active agents；进程由人工终止。
- 无凭据启动：通过 `DOTENV_CONFIG_PATH=runtime/no-such-empty.env npm start` 验证，六个角色均被跳过并输出 `No configured Feishu bots`；未暴露密钥。
- 现有实现未在本次文档更新中修改业务逻辑。
- 已知限制：当前任务存储为本地 JSON，Pi 执行仍需补齐 RPC Runner 和工具执行前的统一策略闸门；这些限制不影响本次 T0 测试记录，但阻止进入第一阶段完成状态。

后续执行从 T1 开始，且每个阶段必须在本文件中补充实际产物路径、测试命令、失败场景和验收证据。
 
## 17. 2026-09-18 执行记录：T1–T4

- T1 已完成：补齐 `validateTransition`、`createHandoff`，任务状态/幂等存储支持恢复与索引清理。
- T2 已完成：新增 `config/agent-registry.json`、六个角色 Profile/Policy 文件和 registry 校验模块。
- T3 已完成：新增 `src/runtime/pi-rpc-runner.js` 与 `src/runtime/agent-runner.js`；JSONL runner 以 `agent_settled` 为完成信号，支持退出失败和超时终止。
- T4 已完成：`config/policy.json` 按角色收紧写入目录；前端/后端目录与产物目录隔离；编排层统一使用 `artifactsDirFor`。
- 验证：`npm test`，67 tests passed，0 failed。
- 当前边界：T3 runner 仍未接入 `src/handlers.js` 主链路；T5 起需先接入交接包校验和领域任务状态，再继续端到端闭环。
