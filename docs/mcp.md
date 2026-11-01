# MCP 操作说明

当前版本支持最小可用的本机 stdio MCP 集成。桌面端在“技能中心”配置服务，网关启动时连接已启用的服务，并把已发现的工具按角色注入 Pi Agent。

## 配置位置

- 桌面端：`<Electron userData>/runtime/mcp.json`
- 命令行网关：`runtime/mcp.json`，也可通过 `PI_MCP_CONFIG_FILE` 指定

配置只保存 server id、名称、启动命令、参数、角色分配和环境变量名映射。例如 `TOKEN: MCP_TOKEN` 表示运行时从当前网关进程的 `MCP_TOKEN` 环境变量读取值；配置文件不会保存环境变量的实际值。

## 生命周期和权限

- 网关启动时连接 enabled 的 stdio server，读取 `tools/list`。
- 首次保存必须明确确认信任启动命令和参数；未信任的服务不会启动或向 Agent 注册工具。
- 技能中心显示连接状态和已发现工具，可停用、重新连接或删除服务。
- 工具名以 `mcp_<server>_<tool>` 暴露给 Agent，角色为空时对所有角色可见，否则只对分配角色可见。
- MCP 调用仍经过 Agent policy gate；敏感文件/凭据参数会被拒绝，任务工具白名单也会继续生效。

当前刻意不支持远程 marketplace、OAuth、SSE 连接和密钥管理。stdio 服务退出后需要在技能中心重新连接或重启网关；这是后续可补的自动重连能力。RPC 运行模式下，每个 Agent 子进程会为当前角色分配到的 MCP 服务建立自己的 stdio 连接，网关与子进程不会共享同一个 MCP 进程。

不要把 `runtime/mcp.json`、环境变量值或任何 MCP 凭据提交到 Git。仓库的 `runtime/` 已在 `.gitignore` 中忽略。
