# Spike 报告：Pi 会话驱动与 tool_call 拦截验证

日期：2026-09-14
状态：已验证
关联设计：[pi-multiagent-feishu-architecture.md](2026-09-14-pi-multiagent-feishu-architecture.md)

## 结论先行

设计文档中两个核心、此前最不确定的技术假设，均已通过本地实测验证：

1. **Pi 会话可被 SDK 内嵌驱动**：`createAgentSession()` 能在同进程内创建会话、执行工具、返回结果，`agent_settled` 是可靠的"任务真正结束"信号。
2. **`tool_call` 可被扩展强制拦截**：扩展订阅 `tool_call` 返回 `{ block: true, reason }` 能在工具执行前阻断，模型会收到拒绝原因并调整行为。

这意味着文档第 5.4 节（桥接层）与第 9 节（权限强制执行）的地基成立，后续编排层、审批流可在此之上建设。

## 验证环境

| 项目 | 值 |
| --- | --- |
| Pi 版本 | 0.85.1（`@earendil-works/pi-coding-agent`） |
| 模型 | `deepseek/deepseek-v4-pro`（thinking=off） |
| 认证 | `DEEPSEEK_API_KEY` 环境变量（本机 `auth.json` 为空） |
| Node | 22 |

## 验证 1：驱动 Pi 会话

脚本：`spike/pi-session.mjs`

```text
[model] deepseek/deepseek-v4-pro (thinking=true)
[tool] ls {"path":"D:/33054/Multyagent Feishu"}
当前目录包含一个 Node.js 项目的典型结构（.env、package.json、src/...）
[agent_end] willRetry=false
[settled] agent_settled fired
```

会话创建、工具调用（`ls`）、回复获取、`agent_settled` 触发——全链路正常。

## 验证 2：tool_call 强制拦截

脚本：`spike/pi-policy.mjs`

```text
[tool] read {"path":"D:/33054/Multyagent Feishu/.env"}
[policy] 拦截工具 read 访问: D:/33054/Multyagent Feishu/.env
我无法读取 .env 文件——工具的读取策略明确禁止访问 .env 密钥文件...
[settled] agent_settled fired
拦截次数: 1
```

关键点：工具在**执行前**被阻断，`.env` 内容从未泄露给模型，且模型**收到拒绝原因**后调整了行为（未继续硬试，而是如实告知无法读取）。

## 关键结论

1. **桥接层优先用 SDK 内嵌**（设计文档中的方案 A），而非 RPC 子进程（方案 B）。对第一步，SDK 更简单、类型安全、同进程直取状态。RPC 子进程留到真正需要进程隔离时。
2. **权限强制的实现路径确认**：扩展 + `pi.on("tool_call")` + 返回 `{ block: true, reason }`。
3. **`agent_settled`（而非 `agent_end`）**是判断任务彻底结束的正确信号，与文档 5.4.2 一致。

## 踩过的坑

1. `new DefaultResourceLoader()` 必须传 `cwd` + `agentDir`，否则 `resolvePath` 收到 `undefined` 抛错。
2. 模型引用用 `modelRuntime.getModel(provider, id)`；静态 `getModel` 从 `@earendil-works/pi-ai` 导入。
3. `ModelRuntime.create()` 应单例化，避免每次任务重复初始化目录。
4. 角色身份只写进 user 消息会被 pi 默认"编程助手"系统提示稀释，模型会幻觉自称错角色；必须用 `systemPromptOverride` 写入系统提示。
5. 飞书多机器人角色串位的常见根因是 `.env` 里 App ID 填错（如前端填了后端的 App ID）；回执里的角色名可用来快速定位路由是否错误。

## 遗留

- 会话持久化（`task_id` ↔ session 映射）与多轮追问复用：实施阶段四。
- per-agent 工具白名单细分：实施阶段一。
- RPC 子进程隔离：第二阶段。

## 步骤 3：端到端飞书验证（已通过）

基于 spike 结论实现了最小桥接层 `src/pi-agent.js`，替换了 `src/handlers.js` 的占位 `runAgent`：

- 每次任务新建 in-memory session，prompt 后 dispose。
- 统一只读工具集 `["read", "ls", "grep", "find"]` + 敏感文件拦截（复用验证 2）。
- 模型 `deepseek/deepseek-v4-pro`（thinking=off），认证走 `DEEPSEEK_API_KEY`。
- 角色身份通过 `systemPromptOverride` 写入系统提示（含职责描述 + "身份固定不得自称其他角色"），而非仅靠 user 消息。

验证链路：`npm test` 3/3 通过；本地直调 `runAgent` 返回真实 Pi 结果；网关启动六个机器人长连接正常；群内 `@机器人` 实测成功（回执 + 真实处理结果回帖）。

当前实现的已知取舍：无会话持久化与多轮追问复用、工具集未按角色细分、无超时与并发闸门。
