# Electron 桌面工作台实现规划

## 已落地的第一阶段

- 网关继续作为唯一任务编排入口，Electron 不复制 TaskStore、审批状态或 Agent 会话。
- 网关启动时创建 loopback-only WebSocket 控制面，监听 `127.0.0.1`，生成随机会话令牌，并把 `{token, port}` 写入 `runtime/desktop-session.token`。
- WebSocket 首条消息必须认证令牌；认证后先返回 TaskStore 快照，再按 `event_id` 补发事件历史，随后推送实时结构化事件。
- 桌面命令只允许 `pause`、`resume`、`terminate`，统一调用现有暂停、恢复、终止机制；命令必须携带令牌。
- Agent 会话目录固定为 `runtime/sessions/<project>/<agent>`；显式传入的旧 session 只有在当前目录内才允许复用。
- Electron 渲染进程启用 context isolation、禁用 Node 集成，通过 preload 暴露最小 WebSocket 客户端。
- 首版工作台展示任务列表、项目归属、结构化执行时间线和生命周期按钮；不展示隐藏推理或原始提示词。
- 桌面端支持按项目建立连接范围，并可从 Agent 列表进入单个 Agent 的事件观察视图。
- 项目经理可在 `deliver_artifact` 中提交结构化阶段计划；计划校验通过后，同阶段任务并行，阶段间按依赖顺序推进。
- 项目经理下发的工具、文件读取和文件写入白名单会进入任务权限快照，并在 Agent 工具调用扩展中二次强制校验。

## 后续阶段边界

1. 增加暂停点/恢复点、产物引用和按项目导出/清理历史。
2. 将网络域名白名单接入实际网络工具，并完善命令/子进程的细粒度权限审计。
4. 增加 Electron 主进程托管网关、托盘驻留、显式退出、凭据设置和 Windows 安装包。

## 本地运行

```powershell
# 终端一：启动网关（会生成 runtime/desktop-session.token）
npm start

# 终端二：构建桌面渲染层
npm run desktop:build

# 启动 Electron
npm run desktop
```

开发时可运行 `npm run desktop:dev`，然后设置 `ELECTRON_RENDERER_URL=http://127.0.0.1:5174` 启动 Electron。
