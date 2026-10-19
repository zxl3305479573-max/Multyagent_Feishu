# MultyAgent 飞书网关

当前版本先接通飞书长连接和机器人身份回传。当前角色为项目经理、架构设计师、前端开发、后端开发、测试和审计，每个角色使用自己的 App ID/App Secret；缺少凭证的角色会被跳过。

## 本地运行

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写项目经理机器人的 `FEISHU_PROJECT_MANAGER_APP_ID` 和 `FEISHU_PROJECT_MANAGER_APP_SECRET`。不要把 `.env` 提交到 Git 或发送到聊天中。

```powershell
npm install
npm run check   # ESLint + 类型检查 + 单元测试
npm start
```

网关运行中按 `Ctrl+C` 会优雅退出：依次断开飞书长连接、关闭桌面控制面和看板轮询、刷新任务快照，最后释放
单实例锁（超时 `PI_SHUTDOWN_TIMEOUT_MS`，默认 10 秒）。

启动后，在已加入机器人的项目群中发送：

```text
@MultyAgent-项目经理 测试连接
```

机器人会先确认收到任务，再由同一个机器人回复处理结果。真实的 MultyAgent 执行逻辑接入 `src/handlers.js` 的 `runAgent`。

## 启用其他角色

1. 在飞书开发者后台为目标角色创建独立的自建应用，开启长连接并订阅 `im.message.receive_v1`。
2. 在本地 `.env` 填入对应的 `FEISHU_<ROLE>_APP_ID` 与 `FEISHU_<ROLE>_APP_SECRET`。
3. 将 `config/roles/<角色>.json` 中的 `enabled` 设为 `true`，然后重启网关。

每个启用角色使用自己的飞书应用凭证接收事件和回复结果。

## 角色配置

每个角色一个文件：`config/roles/<key>.json`，字段说明见同目录的 `role.schema.json`（VS Code 会据此提示和校验）。
网关启动时由 `src/role-config.cjs` 做完整校验，配置有误会直接报错并指出文件和字段。

| 字段 | 作用 |
| --- | --- |
| `displayName` / `order` / `enabled` | 显示名、排列顺序、是否启用 |
| `feishu.appIdEnv` / `feishu.appSecretEnv` | 该角色飞书应用凭据对应的环境变量名 |
| `duty` / `goal` / `rules` / `workflow` | 写进系统提示的职责、目标、行为约束和工作流程 |
| `tools` | 工具白名单 |
| `writePaths` / `denyPaths` | 可写目录与禁止目录（支持 `{project}` 占位符，deny 优先） |
| `shellMode` | `none` 无 Shell；`readonly` 只读命令与测试；`write` 可写但受 `writePaths` 限制 |
| `networkAccess` / `networkDomains` | 是否允许联网及域名白名单 |
| `limits` | 并发数、轮次上限、RPC 模式下的单次超时 |

提示词里“只能写入哪些目录 / Shell 能做什么 / 能否联网”这几条由上述字段自动生成，不要在 `rules` 里重复写路径。

### Agent 权限边界

策略闸门（`src/agent/policy-gate.js`）在每次工具调用前检查：任务级工具白名单 → 敏感文件 → 删除命令 →
联网 → Shell 写入 → write/edit 落点。Shell 命令中的重定向、`cp`/`mv`/`mkdir`/`sed -i`/`Set-Content` 等改写命令，
目标路径必须落在角色可写目录内；`node -e`、`python -c`、`powershell -Command`、`Invoke-Expression` 等内联脚本
一律拒绝；写入命令中不允许 `cd` 切换目录。

这是静态校验，不是沙箱：`npm test` 之类的命令本身仍会执行项目代码。需要强隔离时开启 `PI_AGENT_WORKTREE=1`，
或在受限账户/容器中运行网关。

## 运行日志

### 任务状态存储

任务状态现在统一由 `TaskStore` 持久化，默认文件为 `runtime/domain-tasks.json`，可用
`PI_DOMAIN_TASKS_FILE` 配置。网关和编排层仍通过 `src/tasks.js` 的兼容接口访问，
但该文件不再维护第二份 `runtime/tasks.json` 状态；暂停、终止、会话关联、项目名、
最近任务和消息根别名都写入同一份任务记录。升级已有实例前请备份旧的
`runtime/tasks.json` 与 `runtime/domain-tasks.json`，首次启动后以新的 domain 文件为准。

所有状态文件（任务、待确认项、检查点、看板记录映射、凭据）都先写临时文件再原子替换，进程在写盘中途被杀也
不会留下半截 JSON。如果某个状态文件仍然损坏（例如磁盘故障），它会被改名为 `<文件名>.corrupt-<时间>` 保留现场：
任务文件损坏时网关拒绝启动并提示备份位置，不会用空状态覆盖历史任务；看板映射等可重建的文件则备份后按空处理。

保留所有历史日志，不通过删除旧文件来判断当前状态。网关会追加写入
`runtime/events.jsonl`，每条新事件都包含以下可检索字段：

- `run_id`：一次网关进程启动的唯一标识；先按它区分新旧进程。
- `task_id`、`parent_task_id`、`chat_id`：一次任务与上下游派发的关联键。
- `agent`、`project_name`、`correlation_id`：角色、项目和原始消息关联。
- `sequence`、`timestamp`、`pid`：同一进程内的先后顺序与运行实例。

事件覆盖消息接收与过滤、任务创建/复用/开始/完成/失败、交付、人工确认、
卡片回调及下游派发。排查某次执行时，应先从该消息或任务的 `task_id` 找到
对应记录，再限定同一个 `run_id`；不要把旧 `gateway-live*.log` 中不同角色键或
不同进程的文本直接当成当前配置状态。

修改日志代码后需重启网关，之后产生的事件才会包含这组结构化字段；旧日志仍保留
为历史证据，不会被改写。

`events.jsonl` 超过 `PI_EVENTS_ROTATE_MB`（默认 50）时，网关会在**启动阶段**把它整体移到
`runtime/events-archive/events-<时间>.jsonl`，新文件只保留进行中或 24 小时内结束的任务事件，保证看板与 Trace
重放仍能还原它们。桌面端补发与状态查询从文件尾部倒读，不再整文件读入。

## 多维表格看板

任务状态由网关投影到飞书多维表格；任务表同时是项目经理机器人的 Human
Control Plane。只有项目经理应用访问多维表格，其他角色机器人和 Pi Agent
不需要 Bitable 权限。

在 `.env` 中配置目标表格：

```env
# 飞书里打开的多维表格地址形如 /wiki/<wiki_token>?table=<table_id>
FEISHU_BITABLE_WIKI_TOKEN=<wiki_token>
FEISHU_BITABLE_TABLE_ID=<table_id>
FEISHU_BITABLE_TRACE_TABLE_ID=
FEISHU_BITABLE_CONTROL_POLL_MS=5000
```

如果拿到的是 `/base/<app_token>?table=...` 形式的地址，也可以跳过知识库解析，
直接填 `FEISHU_BITABLE_APP_TOKEN`。项目只需要给项目经理应用开通
`bitable:app` 权限，并把该应用加为表格协作者；其他角色不需要表格权限。

启动时网关会先用 Wiki 节点解析出真实表格 token，再按需补齐看板字段
（只新增，不改名、不改类型、不删除，可通过 `FEISHU_BITABLE_AUTO_INIT=false`
关闭）。字段包括任务编号、标题、项目、负责人、阶段、状态、进度、阻塞、风险、
产物和时间。之后任务创建、派发、等待确认、暂停、恢复、终止、完成或失败都会更新同一条记录，
不会重复插入；`task_id` 是唯一同步键。`控制指令` 只接受精确值 `暂停`、`继续`、`终止`，
成功执行后才清空，未知或失败指令会保留。

配置 `FEISHU_BITABLE_TRACE_TABLE_ID` 后，网关会将 Task、Agent、状态、工具调用、命令、
文件变化、测试、错误和决策投影到独立 Trace 表。Trace 只保存结构化摘要并脱敏凭据，
不记录提示词、隐藏推理、完整工具输出或文件内容；本地 `runtime/events.jsonl` 仍可用于补投。

表格接口异常不会影响机器人执行：同步失败只写日志，审批卡片和下游派发照常进行。
排查时先看启动日志中的 `[bitable]` 前缀，它会说明是配置缺失、token 解析失败、
字段不匹配还是写入被拒。

如果日志出现 `code=91403 Forbidden`，说明应用对该表格只有读取权限，需要两步：

1. 在飞书里把项目经理应用加为该多维表格的**可编辑**协作者。表格挂在知识库
   里时，要把它加入知识库（而非仅单个节点）的协作者，并给编辑权限。
2. 在开放平台确认 `bitable:app` 已添加，并且**发布**了新版本再试；只勾选权限
   但不发布，token 不会带上写权限。

两步都完成后运行 `node scripts/check-bitable.mjs --write`，成功即代表写入链路通畅。

### 看板视图

看板列全部是中文，只保留执行状态需要的部分：

| 列 | 说明 |
| --- | --- |
| 任务 | 主字段，卡片标题 |
| 任务编号 | 同步用的唯一键，排查时用 |
| 项目 | 项目名 |
| 负责人 | 项目经理 / 架构设计师 / 前端开发 / 后端开发 / 测试 / 审计 |
| 状态 | 待开始 / 执行中 / 待确认 / 已暂停 / 已完成 / 失败 |
| 阶段 | 最新生命周期事件（已接单 / 已派发 / 待确认……） |
| 当前动作 | 人类可读的当前进展 |
| 阻塞 / 风险 | 需要介入的事项 |
| 交付物 | 产出文件路径 |
| 开始 / 更新 / 完成时间 | 时间戳 |
| 进度 | 已完成派发角色占计划角色的百分比 |
| 执行角色 | 当前正在执行的角色 |
| 控制指令 | 暂停 / 继续 / 终止（人工填写） |
| 控制结果 | 最近一次控制操作的结果 |

`npm run bitable:setup` 负责把表迁移到这个结构：旧英文列自动改名、历史英文值
翻译成中文、状态与负责人转成中文单选、删掉没人用的空列，并建一个不加筛选的
“全部状态”视图。脚本可重复执行，已满足的状态会跳过，`--dry-run` 只打印计划。

事件流和 `runtime/events.jsonl` 保持英文键不变，只有给人看的表格是中文化；
两边都是 UTF-8，不存在编码问题。

看板视图分组在一个界面里展示全部状态，但分组字段飞书没有开放接口，需要手动设一次：
打开“看板”视图 → 分组选 `状态`，再用 `卡片配置` 勾选要看的信息。

可用的运维命令：

```powershell
npm run bitable:check    # 只读检查字段
npm run bitable:setup    # 对齐字段类型与视图
npm run bitable:smoke    # 端到端验证一任务一行并原地更新
```

### 受控 Agent CLI

确定性的测试、状态读取、交付校验和图表生成可以通过统一 CLI 执行，CLI 返回精简 JSON，完整日志不进入 Agent 上下文：

```powershell
npm run agent:cli -- test
npm run agent:cli -- task-status --task-id TASK-20260928-001 --chat-id oc_xxx
npm run agent:cli -- validate-delivery --task-id TASK-20260928-001 --project student --agent architect --artifacts '["workspace/student/artifacts/TASK-20260928-001/architecture.md"]'
npm run agent:cli -- render-diagram --task-id TASK-20260928-001 --project student --input diagram.json
npm run agent:cli -- bitable --action check
```

CLI 的写入操作必须带项目名，目标路径会限制在 `workspace/<project>/` 下；它不接管飞书消息、人工审批或 Agent 派发，这些仍由网关和编排器负责。

机器人内部的 `agent_cli` 还提供只读的 `bitable-check`；建表、写表和 smoke 维护动作仍只允许人工在终端执行。

### Agent 运行模式

默认使用进程内 Pi 会话：

```powershell
PI_AGENT_RUNTIME=embedded
```

需要进程隔离时可切换到 RPC runner。RPC 子进程会加载同一个策略扩展，因此角色工具白名单、动态写入路径、交付协议、状态查询、项目创建和 `agent_cli` 与 embedded 模式一致；网关以 `agent_settled` 作为完成信号，超时会终止子进程并记录失败：

```powershell
PI_AGENT_RUNTIME=rpc
PI_RPC_COMMAND=pi
```

RPC 子进程与 embedded 模式一样以仓库根目录为 cwd，产物、任务状态文件和交付包仍按当前项目解析。需要 Git 工作树隔离时显式开启（默认关闭，避免 RPC 会话只看到 HEAD 而漏掉当前未提交改动）：

```powershell
PI_AGENT_WORKTREE=1
```

工作树改动会收集为 `worktree-changes.patch` 供审查，不会自动合并；确认后再显式执行闸门命令，冲突时保持主工作区不变：

```powershell
npm run worktree -- list
npm run worktree -- collect --agent frontend_developer --task T-001 --artifacts workspace/student/artifacts/T-001
npm run worktree -- apply --agent frontend_developer --task T-001 --confirm
npm run worktree -- cleanup --agent frontend_developer --task T-001
```

RPC 事件只写入任务、角色、事件类型、工具名和状态等摘要字段，不把模型文本或工具输出复制到事件日志。

## 桌面工作台

```powershell
npm run desktop:build   # 构建渲染层
npm run desktop         # 启动 Electron（自动托管网关子进程）
npm run desktop:package # 生成 Windows 安装包
```

- 渲染进程运行在 Electron 沙箱中，只能通过 preload 暴露的 IPC 调用主进程；会话令牌由主进程读取。
- 凭据用 Windows 数据保护（DPAPI）加密保存在用户目录。系统加密不可用或凭据来自另一台电脑时，设置页会明确提示，
  而不是显示为“未配置”。
- **运行设置**页列出网关与 Agent 读取的全部环境配置（飞书凭据、模型与 API Key、Agent 运行、多维表格、运行与存储），
  可搜索、修改、恢复默认，并标注每项的生效来源（设置 / 系统环境变量 / 桌面端管理 / 默认）。密钥加密保存在
  `credentials.json`，其余配置保存在应用数据目录的 `settings.json`；保存后点“保存并重启服务”即生效。
  配置项清单定义在 `src/env-catalog.cjs`，测试会扫描源码里的 `process.env.*`，新增环境变量未登记时测试失败。
- 网关因配置错误起不来时，窗口仍会打开，可以直接在运行设置里改回来再重启服务。
- 首次启动会从应用目录下的 `.env` 迁移凭据；其他位置可在运行设置或 `MULTYAGENT_LEGACY_ENV_FILE` 中指定。
- 退出时先通过 IPC 请求网关优雅退出，8 秒内未退出再强制结束。

### GitHub 工单

把 GitHub Issues 接到项目经理，完成后自动回写结果（`src/tickets/`）。

1. 在运行设置「GitHub 工单」填写 `GITHUB_TOKEN`（fine-grained token，Issues 读写权限），重启服务。
2. 桌面端侧边栏「工单」→「添加工单源」：仓库 `owner/name` 对应一个本地项目，可按标签、指派人过滤。
3. 在收件箱里点「交给项目经理」：工单正文、附图（先下载到 `workspace/<项目>/artifacts/tickets/<编号>/`）
   和补充说明拼成任务交给项目经理。幂等键 `ticket:github:<repo>#<编号>`，重复派发不会建第二个任务。
4. 根任务结束（完成 / 失败 / 终止）时，把项目经理汇总和测试的结构化验收结论评论到 Issue；
   开启「自动关闭」后，只有任务完成且验收通过（或没有测试环节）才关闭 Issue。
5. 定时拉单：每 N 小时按优先级门槛挑出未处理的工单，每次最多 5 张。优先级从标签推断（`P0`/`critical`/`紧急`
   → 紧急，`P1`/`high`/`高` → 高，以此类推；中、低优先级不会自动拉取）。默认先由项目经理机器人往飞书群推确认卡，
   点「交给项目经理」才开工，点「忽略」后不再推送。

### 桌面端与飞书同时使用

桌面端拉起的网关同时连接飞书机器人和桌面工作台，两边看到的是同一份任务、事件和项目：
飞书里发起的任务会实时出现在桌面端，飞书新建的项目（`workspace/<项目名>`）也会出现在侧边栏；
飞书端项目经理在创建项目时能看到已有项目列表，包括桌面端创建的项目。

- **同一时间只运行一个网关。** 同一套机器人有两个长连接时，飞书只把消息投给其中一个，会出现“点了没反应”。
  网关按项目经理机器人的 App ID 在用户目录 `.multyagent-feishu/locks/` 下加全局锁：已有网关在运行时，
  `npm start` 会拒绝启动，桌面端也不会重复拉起，并提示占用的进程和数据目录。
- **命令行与桌面端共用数据：** 在仓库 `.env` 中设置 `PI_DATA_DIR` 为桌面端数据目录
  （开发版为 `%APPDATA%\Electron`），`npm start` 就会读写同一份 `runtime/`、`workspace/`、`logs/`。
- **合并已有的命令行数据：** 先停止所有网关，再运行

  ```powershell
  npm run data:merge            # 预览
  npm run data:merge -- --apply # 执行；目标原文件先备份到 runtime/merge-backup-<时间>/
  ```

  任务按 `task_id`、事件按 `event_id` 去重合并；仓库里的项目目录以目录联接的方式挂到目标 `workspace/` 下，不搬动文件。

## 开发检查

```powershell
npm run lint       # ESLint（只开启能发现真实缺陷的规则）
npm run typecheck  # 渲染层 TypeScript + 后端带 // @ts-check 的模块
npm test           # node:test 单元测试
npm run check      # 以上全部
```

推送到 GitHub 时 `.github/workflows/ci.yml` 会在 Windows + Node 22 上执行同样的检查并构建渲染层。

## 设计文档

- [项目总览与流转过程](docs/overview.md)
- [飞书多机器人协作设计](docs/superpowers/specs/2026-09-13-multyagent-feishu-bots-design.md)
- [基于 Pi Agent 的多智能体架构设计](docs/superpowers/specs/2026-09-14-pi-multiagent-feishu-architecture.md)
