# MultyAgent 飞书协作网关 · Agent 工作台

六个职责角色（项目经理、架构设计师、前端开发、后端开发、测试、审计）组成一支 AI 团队。你在**飞书项目群**里 `@` 机器人，或在 **Windows 桌面工作台**里按项目提交任务；项目经理拆解需求并派发给其他角色，各角色的 [Pi Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 在受控的项目工作区里写代码、出方案、跑测试，最后由项目经理汇总交付。

一句话：**飞书和桌面端当前台，Pi Agent 干活，编排层调度，六个角色像团队一样协作。**

主要能力：

- **两种入口，一份数据**：飞书群聊与桌面工作台共用同一个网关、同一份任务和项目；不接飞书也能只用桌面端。
- **结构化协作**：项目经理提交阶段计划（assignments），同阶段并行、跨阶段按依赖推进；派发守卫识别“嘴上派发”，验收门禁要求测试给出结论和证据。
- **计划确认门禁**：团队任务中，项目经理完成规划后不会立即派发；必须在桌面工作台确认计划后，下游 Agent 才会开始执行。
- **质量完成门禁**：团队实现任务必须经过“已实现 → 测试角色独立验收 → 审计角色独立审计 → 产品闭环”；开发角色和项目经理的自测、自审只作过程记录，不能代替最终验收。只有用户明确要求项目经理跳过测试与审计时才放行。
- **权限边界**：每个角色有工具白名单、可写目录、Shell 模式和联网白名单，策略闸门在每次工具调用前强制检查。
- **可观测、可控制**：结构化事件日志、飞书多维表格看板与 Trace 表；任务可从发送按钮暂停或继续。
- **可扩展**：给角色安装 Skill 与插件；接入 GitHub Issues 作为工单来源，完成后自动回写结果。

## 目录

- [系统一览](#系统一览)
- [快速开始](#快速开始)
- [桌面工作台](#桌面工作台)
- [接入飞书](#接入飞书)
- [模型配置](#模型配置)
- [角色与协作](#角色与协作)
- [Agent 运行模式](#agent-运行模式)
- [多维表格看板](#多维表格看板)
- [数据、状态与日志](#数据状态与日志)
- [命令行工具与运维脚本](#命令行工具与运维脚本)
- [目录结构](#目录结构)
- [开发与检查](#开发与检查)
- [安全须知](#安全须知)
- [设计文档](#设计文档)

## 系统一览

```text
飞书项目群（六个机器人，可选）      桌面工作台（Electron，本机 WebSocket）
        ↓                                    ↓
接入层       长连接 · 去重 · App ID → 角色映射 · 卡片回调 · 本机控制面 · GitHub 工单
        ↓
编排层       TaskStore · 结构化计划 · 依赖就绪 · 派发守卫 · 验收门禁 · 人工确认 · 暂停检查点
        ↓
Agent 运行时  进程内 Pi 会话（默认）或 RPC 子进程，可选 Git worktree 隔离；加载角色的 Skill 与插件
        ↓
策略层       工具白名单 · 写入目录 · Shell 写入/内联脚本拦截 · 联网白名单
        ↓
工作区       workspace/<project>/{frontend,backend,artifacts}
        ↓
观测层       events.jsonl · 多维表格看板 · Trace 表
```

一次完整任务的典型流转：

```text
用户 → 项目经理    需求与验收标准，提交阶段计划（只在确有需要时派发下游）
     → 架构设计师  架构方案 + 接口契约
     → 前端 / 后端 同阶段并行实现
     → 测试        独立验证，提交结构化验收结论
     → 审计        独立复核全部实现，发现问题阻断流程
     → 项目经理    汇总交付，回到飞书群 / 桌面端
     → 系统        根任务结算后单独输出项目经理最终总结
```

Agent 之间不直接对话，所有跨角色消息都经过编排层。更完整的说明见 [项目总览](docs/overview.md)。

## 快速开始

环境要求：Windows 10/11、Node.js 22 及以上、至少一个模型服务商的 API Key。飞书应用是可选的。

```powershell
npm install
npm run check   # ESLint + 类型检查 + 单元测试
npm run desktop:build
npm run test:e2e  # 真实 Electron Chromium：工作台、运行设置与滚动隔离
```

CI 使用 `npm ci` 安装干净依赖，并依次执行 lint、类型检查、单元测试、桌面构建和真实 E2E；E2E 截图与机器可读报告作为构建产物上传。

### 方式一：桌面工作台（推荐）

```powershell
npm run desktop:build   # 构建渲染层
npm run desktop         # 启动 Electron，自动托管网关子进程
```

首次打开后进入侧边栏「运行设置」：

1. 在「模型」里选择服务商、模型并填写 API Key。
2. 不用飞书就关闭「启用飞书」；要用飞书则填写各角色的 App ID / App Secret（见[接入飞书](#接入飞书)）。
3. 点「保存并重启服务」，回到对话页新建项目、提交任务。

凭据由 Windows 数据保护（DPAPI）加密保存在本机，不需要 `.env`。

### 方式二：命令行网关

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：填写模型配置（`PI_AGENT_PROVIDER`、`PI_AGENT_MODEL` 和对应的 API Key），以及至少项目经理机器人的 `FEISHU_PROJECT_MANAGER_APP_ID` / `FEISHU_PROJECT_MANAGER_APP_SECRET`。不要把 `.env` 提交到 Git 或发到聊天里。

```powershell
npm start
```

启动后在已加入机器人的项目群中发送：

```text
@MultyAgent-项目经理 测试连接
```

机器人会先回执“已接收”，再由同一个机器人回复处理结果。

网关运行中按 `Ctrl+C` 会优雅退出：依次断开飞书长连接、关闭桌面控制面和看板轮询、刷新任务快照，最后释放单实例锁（超时 `PI_SHUTDOWN_TIMEOUT_MS`，默认 10 秒）。

### 仅桌面端模式

设置 `FEISHU_ENABLED=false`（或在运行设置里关闭「启用飞书」）后，网关不连接任何飞书机器人、不同步多维表格、不加全局锁，已保存的 App ID / Secret 保留但不使用。此时桌面端任务只需要模型凭据，六个角色照常协作。

开启飞书时，只有填写了 App ID 与 Secret 的角色会连接飞书；缺凭据的角色仍可处理桌面端任务，但飞书群里的任务派不到它。

## 桌面工作台

```powershell
npm run desktop:build     # 构建渲染层
npm run desktop           # 启动 Electron
npm run desktop:dev       # 渲染层开发服务器（Vite，端口 5174）
npm run desktop:portable  # 生成免安装目录版
npm run desktop:package   # 生成 Windows 安装包（输出到 release/）
```

### 界面

- **无边框窗口**：隐藏系统标题栏，顶栏即拖拽区，Windows 保留右上角的系统窗口按钮。关闭窗口时最小化到托盘，从托盘菜单退出。
- **侧边栏**：项目切换、新建项目 / 新建对话、最近任务，以及工单、机器人能力、运行设置入口；可折叠。
- **顶栏**：当前任务名、所属项目和任务状态。
- **六个主机器人独立展示**：项目经理、架构设计师、前端、后端、测试、审计分别拥有独立执行卡片。没有任务分片的角色直接在主卡片中展示执行过程、结论和交付文件；发生分片时才显示从 `1号` 开始编号的可折叠子机器人。
- **主机器人汇总**：角色卡片会把该角色所有执行实例的结论合并展示，并去重汇总全部交付文件，便于直接查看主机器人及子机器人的完整结果。
- **工具调用说明**：连续工具调用会合并为折叠块，每一次调用都显示简短说明，例如“运行测试：npm test”“编辑文件：src/app.tsx”；说明经过长度限制和密钥脱敏。
- **最终总结**：根任务全部完成并结算后，项目经理会再单独输出一次最终总结，包含全部子任务结论、统计、验收结果、风险和交付文件。
- **同任务续聊**：选中已有任务后，输入框的新消息会作为该任务的后续轮次发送；复用根任务与 Pi 会话文件，并把用户消息和阶段摘要持久化到任务记录，session 丢失时仍可恢复关键记忆。需要全新任务时点「新建项目对话」。
- **输入框运行选择**：右下角显示当前模型与思考强度；点开即可切换服务商、模型和思考等级，后续 Agent 立即使用新配置，并自动写回运行设置。
- **自适应内容区**：对话、运行设置、机器人能力、工单和项目上下文都随窗口宽度调整；宽屏使用多列，窄屏自动收起侧栏并改为单列。
- **项目上下文**：项目统计、阶段摘要，支持导出快照、归档与恢复历史。
- **运行设置**：左侧按「一级分组 → 二级标题」列出配置目录，右侧一次展示一个配置页面；可搜索、修改、恢复默认，并标注每项的生效来源（设置 / 系统环境变量 / 桌面端管理 / 默认）。关闭飞书后，飞书与看板分组自动收起。

### 安全与运行

- 渲染进程运行在 Electron 沙箱中，只能通过 preload 暴露的 IPC 调用主进程；会话令牌由主进程读取，只接受来自本应用页面的 IPC。
- 密钥加密保存在应用数据目录的 `credentials.json`，其余配置保存在 `settings.json`。系统加密不可用或凭据来自另一台电脑时，设置页会明确提示，而不是显示为“未配置”。
- 配置项清单定义在 `src/env-catalog.cjs`，测试会扫描源码里的 `process.env.*`，新增环境变量未登记时测试失败。
- 网关因配置错误起不来时，窗口仍会打开，可以直接在运行设置里改好再重启服务。
- 首次启动会从应用目录下的 `.env` 迁移凭据；其他位置可在运行设置或 `MULTYAGENT_LEGACY_ENV_FILE` 中指定。
- 退出时先通过 IPC 请求网关优雅退出，8 秒内未退出再强制结束。

### 机器人能力（Skill 与插件）

侧边栏「机器人能力」可以给各个角色添加能力，按角色分配、随时停用或移除，下一次执行即生效，无需重启网关：

- **基础能力**：按六个机器人分别展示当前具备的默认工具（读取、搜索、文件写入、Shell、任务状态、交付等）。所有基础工具默认启用，也可以逐项取消勾选；变更只影响对应角色，并在下一轮 Agent 启动时生效。基础能力来自角色配置和运行时桥接，不会被删除。
- **Skill**：含 `SKILL.md` 的文件夹（Agent Skills 标准），提供规范、流程、检查清单等指引；可从 GitHub（`owner/repo/子目录@分支`）、本地文件夹安装，或在桌面端直接编写。分配给角色的 Skill 目录始终可读。
- **插件**：`plugin.json` + 入口脚本（Pi 扩展），为角色提供新工具。代码在网关进程内运行，安装时必须确认信任；工具调用仍经过策略闸门。

安装后的文件位于数据目录 `capabilities/skills/` 与 `capabilities/plugins/`，基础能力开关、Skill/插件分配记录在 `runtime/capabilities.json`。内置模式与 RPC 模式都会按选择结果加载。编写模板与安全说明见 [docs/capabilities.md](docs/capabilities.md)。

### GitHub 工单

把 GitHub Issues 接到项目经理，完成后自动回写结果（`src/tickets/`）。

1. 在运行设置「GitHub 工单」填写 `GITHUB_TOKEN`（fine-grained token，Issues 读写权限），重启服务。
2. 侧边栏「工单」→「添加工单源」：仓库 `owner/name` 对应一个本地项目，可按标签、指派人过滤。
3. 在收件箱里点「交给项目经理」：工单正文、附图（先下载到 `workspace/<项目>/artifacts/tickets/<编号>/`）和补充说明拼成任务交给项目经理。幂等键 `ticket:github:<repo>#<编号>`，重复派发不会建第二个任务。
4. 根任务结束（完成 / 失败 / 终止）时，把项目经理汇总和测试的结构化验收结论评论到 Issue；开启「自动关闭」后，只有任务完成且验收通过（或没有测试环节）才关闭 Issue。
5. 定时拉单：每 N 小时按优先级门槛挑出未处理的工单，每次最多 5 张。优先级从标签推断（`P0`/`critical`/`紧急` → 紧急，`P1`/`high`/`高` → 高，以此类推；中、低优先级不会自动拉取）。接入飞书时先由项目经理机器人往群里推确认卡，点「交给项目经理」才开工，点「忽略」后不再推送；未接入飞书时直接派发。

### 桌面端与飞书同时使用

桌面端拉起的网关同时连接飞书机器人和桌面工作台，两边看到的是同一份任务、事件和项目：飞书里发起的任务会实时出现在桌面端，飞书新建的项目（`workspace/<项目名>`）也会出现在侧边栏；飞书端项目经理创建项目时能看到已有项目列表，包括桌面端创建的。

- **同一时间只运行一个网关。** 同一套机器人有两个长连接时，飞书只把消息投给其中一个，会出现“点了没反应”。网关按项目经理机器人的 App ID 在用户目录 `.multyagent-feishu/locks/`（可用 `PI_LOCK_DIR` 修改）下加全局锁：已有网关在运行时，`npm start` 会拒绝启动，桌面端也不会重复拉起，并提示占用的进程和数据目录。仅桌面端模式不加这把锁。
- **命令行与桌面端共用数据：** 在仓库 `.env` 中把 `PI_DATA_DIR` 设为桌面端数据目录（开发版为 `%APPDATA%\Electron`），`npm start` 就会读写同一份 `runtime/`、`workspace/`、`logs/`。
- **合并已有的命令行数据：** 先停止所有网关，再运行

  ```powershell
  npm run data:merge            # 预览
  npm run data:merge -- --apply # 执行；目标原文件先备份到 runtime/merge-backup-<时间>/
  ```

  任务按 `task_id`、事件按 `event_id` 去重合并；仓库里的项目目录以目录联接的方式挂到目标 `workspace/` 下，不搬动文件。

## 接入飞书

每个角色对应一个独立的飞书自建应用，用自己的凭证接收事件和回复结果。

1. 在飞书开发者后台为角色创建自建应用，开启机器人能力和长连接，订阅 `im.message.receive_v1`，发布版本并把机器人拉进项目群。
2. 在运行设置（或 `.env`）填入对应的 `FEISHU_<ROLE>_APP_ID` 与 `FEISHU_<ROLE>_APP_SECRET`。
3. 确认 `config/roles/<角色>.json` 中 `enabled` 为 `true`，然后重启服务。

可选配置：

- `FEISHU_ALLOWED_CHAT_ID`：只处理指定群的消息。
- 群聊里“@ 谁谁才响应”依赖机器人的 open_id，路由异常时运行 `node scripts/check-bot-identity.mjs` 核对每个机器人的身份。

## 模型配置

| 变量 | 说明 |
| --- | --- |
| `PI_AGENT_PROVIDER` | pi-coding-agent 中的服务商 ID，默认 `deepseek` |
| `PI_AGENT_MODEL` | 服务商下的模型 ID，默认 `deepseek-flash` |
| `PI_AGENT_THINKING` | 全局思考强度；设置后覆盖角色配置，未设置时使用角色的 `thinking` |
| `<PROVIDER>_API_KEY` | 对应服务商的 API Key，例如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` |
| `PI_AGENT_BASE_URL` | 自定义模型网关地址，例如 Ollama `http://localhost:11434/v1` |
| `PI_AGENT_API_TYPE` | 自定义协议：`openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai` |
| `PI_AGENT_API_KEY` | 自定义服务商的通用 Key；不会写入生成的模型文件 |
| `PI_AGENT_MODELS_FILE` | 直接指定 Pi 的 `models.json`，优先于上面的自定义 Base URL 配置 |

运行设置内置了 DeepSeek、OpenAI、Anthropic、Google Gemini、Azure OpenAI、OpenRouter、Moonshot / Kimi、Z.AI、Qwen、MiniMax、Xiaomi MiMo、Mistral、Groq 等服务商，选择后只显示该服务商需要的 Key；也可以填写自定义服务商 ID。完整清单见 `src/env-catalog.cjs`。

### 接入本地或自定义模型

在运行设置「模型」里填写服务商 ID、模型 ID、Base URL 和 API 协议即可，例如：

```text
PI_AGENT_PROVIDER=ollama
PI_AGENT_MODEL=qwen2.5-coder:7b
PI_AGENT_BASE_URL=http://localhost:11434/v1
PI_AGENT_API_TYPE=openai-completions
PI_AGENT_API_KEY=ollama
```

网关会生成 `runtime/pi-agent/models.json`，内置与 RPC 两种运行模式都会加载。API Key 不会写入该文件，而是在请求时从环境变量读取。上下文窗口、最大输出 Token、推理能力和 OpenAI 兼容参数可在高级选项中设置。

需要同时声明多个服务商或 Pi 原生高级字段时，直接指定 `PI_AGENT_MODELS_FILE`。文件格式与 Pi 官方 `models.json` 一致；使用 RPC 模式时，`auth.json` 应与该文件位于同一目录。

架构设计师与项目经理会使用 diagram-design 技能绘制架构图，默认读取 `~/.codex/skills/diagram-design`，可用 `PI_DIAGRAM_SKILL_PATH` 覆盖；打包时若存在 `skills/diagram-design` 会随包附带并优先使用。

## 角色与协作

### 角色配置

每个角色一个文件：`config/roles/<key>.json`，字段说明见同目录的 `role.schema.json`（VS Code 会据此提示和校验）。网关启动时由 `src/role-config.cjs` 做完整校验，配置有误会直接报错并指出文件和字段。

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

提示词里“只能写入哪些目录 / Shell 能做什么 / 能否联网”由上述字段自动生成，不要在 `rules` 里重复写路径。

| 角色 | 职责 | 可写目录 | Shell |
| --- | --- | --- | --- |
| 项目经理 | 拆解需求、编排、汇总 | `workspace/{project}/artifacts` | 只读 |
| 架构设计师 | 架构方案、接口契约、技术风险 | `workspace/{project}/artifacts` | 只读 |
| 前端开发 | 页面、组件、交互 | `workspace/{project}/frontend`、`artifacts` | 可写（受目录限制） |
| 后端开发 | 接口、业务逻辑、数据模型 | `workspace/{project}/backend`、`artifacts` | 可写（受目录限制） |
| 测试 | 测试设计与执行、缺陷反馈 | `workspace/{project}/artifacts` | 只读 |
| 审计 | 代码质量、安全、依赖、权限 | `workspace/{project}/artifacts` | 无 |

### 派发与交付

- **验收矩阵**：团队功能任务开发前必须提交 `plan.acceptanceMatrix`；每项包含 `id`、`criterion`、`verifier`、`method`、`evidence`、`returnTo`。`verifier` 只能是 `tester` 或 `auditor`，开发角色和项目经理不能作为最终验证者。
- **独立门禁**：项目经理提交 `final=true` 后，编排层仍会检查测试角色的独立验收和审计角色的独立审计。开发自测不作为最终依据；缺失时自动补派测试或审计角色，门禁未通过不能结算。用户明确要求跳过时会在任务策略中记录并跳过两者。
- **证据报告**：任务结束时会根据结构化事件生成 `quality-report.json` 与 `quality-report.md`，记录实现、开发自测记录、独立验收、独立审计和产品闭环状态，以及 AC 检查、测试/构建/E2E 证据和失败项。开发自测仅供记录，不计入最终验收与上线结论。
- **结构化计划**：项目经理在 `deliver_artifact` 中提交 `assignments` / 阶段计划才会真正派发；同阶段并行，阶段之间按依赖推进。默认路由见 `config/routes.json`。
- **交接契约**：每次交付必带结论、产物、证据、假设；产物路径限制在当前项目的工作区内。
- **最终汇总**：项目经理发起的任务链，只有项目经理的 `final=true` 才算收尾；其他角色声明 `final` 仍会交回项目经理汇总。失败也交回项目经理重新决策。根任务结算后，系统再生成一条独立的 `final_summary`，单独展示最终总结。
- **结论与文件聚合**：项目经理最终交付会合并所有子机器人文件并去重；桌面端每个主机器人也会汇总自身全部执行实例的结论和产物。
- **派发守卫**（`src/orchestrator/guards.js`）：项目经理只在文字里写“已派发给前端”，或提交的 assignments 全部无效被过滤时，编排层先要求纠正一次，仍失败再按文字推断目标角色兜底派发，避免任务悄悄卡住。
- **验收门禁**：测试必须提交结构化验收结果——`verdict=pass` 需全部检查通过且至少一条证据，`fail` 需写明失败项，`skip` 需写明原因。“单元测试通过 / 页面能打开”不能当作通过；未通过时交回项目经理决定打回谁修复。
- **人工确认**：需要用户拍板的选项通过飞书卡片或桌面端确认；暂停时保存检查点，继续后从检查点恢复。

### Agent 权限边界

策略闸门（`src/agent/policy-gate.js`）在每次工具调用前依次检查：任务级工具白名单 → 敏感文件 → 删除命令 → 联网 → Shell 写入 → write/edit 落点。Shell 命令中的重定向、`cp`/`mv`/`mkdir`/`sed -i`/`Set-Content` 等改写命令，目标路径必须落在角色可写目录内；`node -e`、`python -c`、`powershell -Command`、`Invoke-Expression` 等内联脚本一律拒绝；写入命令中不允许 `cd` 切换目录。

这是静态校验，不是沙箱：`npm test` 之类的命令本身仍会执行项目代码。需要强隔离时开启 `PI_AGENT_WORKTREE=1`，或在受限账户 / 容器中运行网关。

## Agent 运行模式

默认使用进程内 Pi 会话：

```env
PI_AGENT_RUNTIME=embedded
```

需要进程隔离时切换到 RPC runner。RPC 子进程加载同一个策略扩展，角色工具白名单、动态写入路径、交付协议、状态查询、项目创建、`agent_cli` 以及角色的 Skill 与插件都与 embedded 模式一致；网关以 `agent_settled` 作为完成信号，超时会终止子进程并记录失败：

```env
PI_AGENT_RUNTIME=rpc
PI_RPC_COMMAND=pi
```

RPC 子进程同样以仓库根目录为 cwd。需要 Git 工作树隔离时显式开启（默认关闭，避免 RPC 会话只看到 HEAD 而漏掉未提交改动）：

```env
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

## 多维表格看板

任务状态由网关投影到飞书多维表格，任务表同时是项目经理机器人的人工控制面。只有项目经理应用访问多维表格，其他角色机器人和 Pi Agent 不需要 Bitable 权限。仅桌面端模式下看板不启用。

```env
# 飞书里打开的多维表格地址形如 /wiki/<wiki_token>?table=<table_id>
FEISHU_BITABLE_WIKI_TOKEN=<wiki_token>
FEISHU_BITABLE_TABLE_ID=<table_id>
FEISHU_BITABLE_TRACE_TABLE_ID=
FEISHU_BITABLE_CONTROL_POLL_MS=5000
```

拿到的是 `/base/<app_token>?table=...` 形式的地址时，可以跳过知识库解析，直接填 `FEISHU_BITABLE_APP_TOKEN`。项目经理应用需要开通 `bitable:app` 权限，并被加为表格的可编辑协作者。

- 启动时按需补齐看板字段（只新增，不改名、不改类型、不删除；`FEISHU_BITABLE_AUTO_INIT=false` 关闭）。
- 任务创建、派发、等待确认、暂停、恢复、终止、完成或失败都更新同一条记录，`task_id` 是唯一同步键。
- `控制指令` 列只接受精确值 `暂停`、`继续`、`终止`，成功执行后才清空，未知或失败的指令会保留。
- 配置 `FEISHU_BITABLE_TRACE_TABLE_ID` 后，Task、Agent、状态、工具调用、命令、文件变化、测试、错误和决策会投影到独立 Trace 表。Trace 只保存结构化摘要并脱敏凭据，不记录提示词、隐藏推理、完整工具输出或文件内容。
- 表格接口异常不影响机器人执行：同步失败只写日志（前缀 `[bitable]`），网络故障后按 `FEISHU_BITABLE_NETWORK_BACKOFF_MS` 退避重试。

### 看板列

| 列 | 说明 |
| --- | --- |
| 任务 / 任务编号 | 卡片标题 / 同步用的唯一键 |
| 项目 / 负责人 / 执行角色 | 项目名、负责角色、当前正在执行的角色 |
| 状态 | 待开始 / 执行中 / 待确认 / 已暂停 / 已完成 / 失败 |
| 阶段 / 当前动作 | 最新生命周期事件、人类可读的当前进展 |
| 阻塞 / 风险 / 交付物 | 需要介入的事项、产出文件路径 |
| 进度 | 已完成派发角色占计划角色的百分比 |
| 开始 / 更新 / 完成时间 | 时间戳 |
| 控制指令 / 控制结果 | 人工填写的暂停 / 继续 / 终止，以及最近一次结果 |

`npm run bitable:setup` 把表迁移到这个结构：旧英文列改名、历史英文值翻译成中文、状态与负责人转成中文单选、删除空列，并建一个“全部状态”视图。脚本可重复执行，`--dry-run` 只打印计划。看板视图的分组字段飞书没有开放接口，需要手动设一次：打开“看板”视图 → 分组选 `状态`。

### 常见问题：`code=91403 Forbidden`

应用对该表格只有读取权限，需要两步：

1. 把项目经理应用加为该多维表格的**可编辑**协作者。表格挂在知识库里时，要加入知识库（而非单个节点）的协作者。
2. 在开放平台确认 `bitable:app` 已添加，并且**发布**了新版本；只勾选权限不发布，token 不会带上写权限。

完成后运行 `npm run bitable:check -- --write`，成功即代表写入链路通畅。

## 数据、状态与日志

### 数据目录

命令行网关默认把数据放在仓库内；桌面端放在应用数据目录。两者都可以用 `PI_DATA_DIR` 指向同一处：

```text
<数据目录>/
├── runtime/       任务状态、事件日志、看板映射、能力分配等
├── workspace/     各项目工作区：<project>/{frontend,backend,artifacts}
├── capabilities/  已安装的 Skill 与插件
└── logs/          网关运行日志
```

### 任务状态

任务状态统一由 `TaskStore`（`src/domain/task-store.js`）持久化到 `runtime/domain-tasks.json`（可用 `PI_DOMAIN_TASKS_FILE` 修改）；暂停、终止、会话关联、项目名、最近任务和消息根别名都写在同一份记录里。看板、Trace、桌面端都是它与事件日志的投影。

所有状态文件都先写临时文件再原子替换，进程在写盘中途被杀也不会留下半截 JSON。状态文件损坏时会改名为 `<文件名>.corrupt-<时间>` 保留现场：任务文件损坏时网关拒绝启动并提示备份位置，不会用空状态覆盖历史；看板映射等可重建的文件备份后按空处理。

### 事件日志

网关追加写入 `runtime/events.jsonl`，每条事件包含：

- `run_id`：一次网关进程启动的唯一标识；先按它区分新旧进程。
- `task_id`、`parent_task_id`、`chat_id`：任务与上下游派发的关联键。
- `agent`、`project_name`、`correlation_id`：角色、项目和原始消息关联。
- `sequence`、`timestamp`、`pid`：同一进程内的先后顺序与运行实例。

事件覆盖消息接收与过滤、任务创建 / 复用 / 开始 / 完成 / 失败、交付、人工确认、卡片回调、下游派发、工单与能力变更。排查时先用 `task_id` 找到记录，再限定同一个 `run_id`。

`events.jsonl` 超过 `PI_EVENTS_ROTATE_MB`（默认 50）时，网关在**启动阶段**把它移到 `runtime/events-archive/events-<时间>.jsonl`，新文件只保留进行中或 24 小时内结束的任务事件。桌面端补发与状态查询从文件尾部倒读，不整文件读入。

## 命令行工具与运维脚本

### 受控 Agent CLI

确定性的测试、状态读取、交付校验和图表生成通过统一 CLI 执行，返回精简 JSON，完整日志不进入 Agent 上下文：

```powershell
npm run agent:cli -- test
npm run agent:cli -- task-status --task-id TASK-20260928-001 --chat-id oc_xxx
npm run agent:cli -- validate-delivery --task-id TASK-20260928-001 --project student --agent architect --artifacts '["workspace/student/artifacts/TASK-20260928-001/architecture.md"]'
npm run agent:cli -- render-diagram --task-id TASK-20260928-001 --project student --input diagram.json
npm run agent:cli -- bitable --action check
```

CLI 的写入操作必须带项目名，目标路径限制在 `workspace/<project>/` 下；它不接管飞书消息、人工审批或 Agent 派发。机器人内部的 `agent_cli` 只提供只读的 `bitable-check`，建表、写表和 smoke 只允许人工在终端执行。

### 运维命令

| 命令 | 作用 |
| --- | --- |
| `npm run smoke` | 本地冒烟测试，验证 Pi 桥接层核心链路（调用真实模型，消耗 token） |
| `npm run bitable:check` | 只读检查看板字段（加 `-- --write` 验证写入） |
| `npm run bitable:setup` | 对齐看板字段类型与视图 |
| `npm run bitable:smoke` | 端到端验证一任务一行并原地更新 |
| `npm run data:merge` | 合并命令行与桌面端数据 |
| `npm run worktree -- <子命令>` | 管理 RPC 工作树改动 |
| `node scripts/check-bot-identity.mjs` | 查看各机器人的 open_id 与应用名 |
| `node scripts/create-bitable-trace.mjs` | 创建 Trace 表 |

## 目录结构

```text
config/
  roles/              六个角色的配置与 role.schema.json
  routes.json         默认派发路由
desktop/
  electron/           主进程、preload、托盘与图标
  renderer/           React 渲染层（Vite）
src/
  index.js            网关入口：飞书长连接、桌面控制面、看板与工单
  orchestrator.js     编排层；orchestrator/ 下是计划、路由、守卫、待确认存储
  pi-agent.js         Pi 会话构造与执行
  agent/              策略闸门、提示词、工具与工具事件
  runtime/            embedded / RPC runner、Pi 扩展、worktree
  domain/             任务模型、TaskStore、DAG、交付、审计、Trace
  capabilities/       Skill 与插件注册表
  tickets/            GitHub 工单：拉取、附图、优先级、回写
  env-catalog.cjs     全部环境配置的清单（运行设置据此渲染）
scripts/              运维、诊断与冒烟脚本
test/                 node:test 单元测试
docs/                 总览、设计文档与实施计划
workspace/            各项目工作区（默认数据目录下）
```

## 开发与检查

```powershell
npm run lint       # ESLint（只开启能发现真实缺陷的规则）
npm run typecheck  # 渲染层 TypeScript + 后端带 // @ts-check 的模块
npm test           # node:test 单元测试
npm run check      # 以上全部
npm run test:e2e   # 需先 npm run desktop:build；生成 test-results/desktop-e2e/
```

修改网关代码后需重启网关（桌面端在运行设置里点“重启服务”）才会生效；修改渲染层后重新 `npm run desktop:build`，或用 `npm run desktop:dev` 配合 `ELECTRON_RENDERER_URL` 热更新。

## 安全须知

1. **凭据不进仓库、不进聊天。** `.env` 已被忽略；桌面端凭据用 DPAPI 加密，只在本机可读。曾在聊天中暴露过的 App Secret 请到开放平台重置。
2. **Shell 静态校验不是沙箱。** 它能拦住越权写入和常见的删除 / 联网命令，但测试命令本身会执行项目代码；需要强隔离时开启 worktree 或在受限账户 / 容器中运行。
3. **插件是可执行代码。** 只安装你信任的插件；Skill 只是文本，但同样会影响 Agent 行为。
4. **安装包内是明文源码。** 网关以 Node 子进程运行，打包时未使用 asar。

## 设计文档

- [项目总览与流转过程](docs/overview.md)
- [机器人能力：Skill 与插件](docs/capabilities.md)
- [飞书多机器人协作设计](docs/superpowers/specs/2026-09-13-multyagent-feishu-bots-design.md)
- [基于 Pi Agent 的多智能体架构设计](docs/superpowers/specs/2026-09-14-pi-multiagent-feishu-architecture.md)
- [多维表格看板设计](docs/superpowers/specs/2026-09-22-bitable-task-board-design.md) · [控制面与 Trace 设计](docs/superpowers/specs/2026-09-23-bitable-control-trace-design.md)
- [桌面工作台设计](docs/superpowers/specs/2026-09-30-codex-style-desktop-workspace-design.md)
