# T0 基线验证记录

- 日期：2026-09-18
- 项目：MultyAgent Feishu
- 目的：确认现有飞书接入、任务路由和基础测试没有回归。

## 验证结果

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 自动化测试 | 通过 | `npm test`：51 tests、0 failures、0 skipped |
| 六角色长连接 | 通过（本地凭据环境） | `npm start` 输出 six active agents：project_manager、architect、frontend_developer、backend_developer、tester、auditor |
| 无凭据启动 | 通过 | `DOTENV_CONFIG_PATH=runtime/no-such-empty.env npm start` 跳过六个角色并输出 `No configured Feishu bots` |
| 消息入口 | 已实现 | `im.message.receive_v1` 注册于 `src/index.js` |
| 角色路由 | 已实现 | `config/agents.json` 的 App ID 环境变量映射 |
| 消息去重 | 已实现 | `src/gateway.js` 的 message ID deduper |
| 原机器人回复 | 已实现 | `sendText()` 使用 `receive_id_type=chat_id` |
| 任务持久化 | 已实现（基础版） | `src/tasks.js` 写入 `runtime/tasks.json` |

## 已知限制

- 当前任务存储为本地 JSON，尚未升级为 SQLite 或事件溯源存储。
- Pi RPC Runner 已实现并可通过 `PI_AGENT_RUNTIME=rpc` 接入网关主链路；RPC 模式与内置模式共用同一套工具白名单、动态写入策略闸门、交付协议和 `agent_cli`，统一执行前策略闸门已落地；交接包 Schema 的进一步强约束仍待后续阶段补齐。
- `npm start` 的真实飞书事件接收仍需要在已配置凭据和项目群中进行现场验证。

## 结论

T0 基线检查通过，可以进入 T1；但尚未达到第一阶段完成定义。
