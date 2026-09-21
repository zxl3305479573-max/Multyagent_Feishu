# MultyAgent 飞书网关

当前版本先接通飞书长连接和机器人身份回传。当前角色为项目经理、架构设计师、前端开发、后端开发、测试和审计，每个角色使用自己的 App ID/App Secret；缺少凭证的角色会被跳过。

## 本地运行

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写项目经理机器人的 `FEISHU_PROJECT_MANAGER_APP_ID` 和 `FEISHU_PROJECT_MANAGER_APP_SECRET`。不要把 `.env` 提交到 Git 或发送到聊天中。

```powershell
npm install
npm test
npm start
```

启动后，在已加入机器人的项目群中发送：

```text
@MultyAgent-项目经理 测试连接
```

机器人会先确认收到任务，再由同一个机器人回复处理结果。真实的 MultyAgent 执行逻辑接入 `src/handlers.js` 的 `runAgent`。

## 启用其他角色

1. 在飞书开发者后台为目标角色创建独立的自建应用，开启长连接并订阅 `im.message.receive_v1`。
2. 在本地 `.env` 填入对应的 `FEISHU_<ROLE>_APP_ID` 与 `FEISHU_<ROLE>_APP_SECRET`。
3. 将 `config/agents.json` 中对应角色的 `enabled` 设为 `true`，然后重启网关。

每个启用角色使用自己的飞书应用凭证接收事件和回复结果。

## 设计文档

- [项目总览与流转过程](docs/overview.md)
- [飞书多机器人协作设计](docs/superpowers/specs/2026-09-13-multyagent-feishu-bots-design.md)
- [基于 Pi Agent 的多智能体架构设计](docs/superpowers/specs/2026-09-14-pi-multiagent-feishu-architecture.md)
