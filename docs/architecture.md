# Architecture

本次整理只调整源码位置和模块边界，不改变运行链路、协议、数据格式或产品行为。

## 两个入口面

### Feishu

命令行入口是 `src/index.js`，它只加载 `src/runtime/bootstrap.js`。启动层负责组装共享的任务存储、事件日志、编排器、Agent bridge、Bitable 和桌面控制面；飞书消息与卡片事件通过 `src/integrations/feishu/handlers.js` 进入运行时网关。

```text
src/index.js
    |
    v
src/runtime/bootstrap.js
    |
    +--> src/integrations/feishu/handlers.js --> src/runtime/gateway.js
    +--> src/integrations/bitable-*.js
    +--> src/desktop/desktop-host.js
```

### Desktop

Electron 产品入口是 `desktop/electron/main.cjs`。它通过 `desktop/electron/gateway-process.cjs` 启动同一个 `src/index.js`，再通过本机 WebSocket 连接 `src/desktop/desktop-host.js`。桌面端与飞书共用同一进程内的任务、事件、项目和 Agent 执行链。

```text
desktop/electron/main.cjs
    |
    v
desktop/electron/gateway-process.cjs --> src/index.js
                                             |
                                             v
                                      src/desktop/desktop-host.js
```

## 层次图

```text
runtime/
  bootstrap, gateway, Pi bridge, model, session, observability, lifecycle
       |
       +--> integrations/       Feishu, Bitable, diagram
       +--> desktop/            Node host-side desktop control
       +--> agent/              prompts, tools, policy, orchestration, quality gates
       +--> domain/             tasks, projects, events, tickets, artifacts, persistence
       +--> mcp/                MCP configuration, services, and tool bridge
       +--> capabilities/       built-in capabilities, Skills, and plugins registry
```

层之间的职责如下：

- `src/runtime/` 负责启动和运行时生命周期，连接入口层与共享服务。
- `src/agent/` 负责提示词、工具、策略闸门、编排和质量门禁。
- `src/domain/` 负责任务、项目、事件、工单、产物以及持久化模型。
- `src/desktop/` 负责 Node host 侧的桌面 WebSocket 控制面；Electron UI 仍在 `desktop/`。
- `src/integrations/` 负责飞书、Bitable 和图表等外部系统接入。
- `src/mcp/` 和 `src/capabilities/` 保持独立边界，分别提供 MCP 服务与能力注册。

两种入口最终共享 `src/agent/` 的执行链和 `src/domain/` 的状态模型。用户数据仍写入数据目录下的 `runtime/`、`workspace/` 和 `logs/`；本次整理没有移动这些目录。
