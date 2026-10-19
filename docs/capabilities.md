# 机器人能力：Skill 与插件

在桌面端侧边栏「机器人能力」里给各个角色（项目经理、架构、前端、后端、测试、审计）添加能力。
能力按角色分配、可随时停用或移除；改动在该角色**下一次执行**时生效，不需要重启网关。

| | Skill | 插件 |
|---|---|---|
| 提供什么 | 知识与操作指引（规范、流程、检查清单、参考资料） | 新工具（Agent 可以调用的函数） |
| 形式 | 含 `SKILL.md` 的文件夹（[Agent Skills 标准](https://agentskills.io)） | `plugin.json` + 入口脚本（Pi 扩展） |
| 来源 | GitHub、本地文件夹、桌面端直接编写 | GitHub、本地文件夹 |
| 安全 | 只是文本；Agent 用 read 工具按需读取 | 代码在网关进程内运行，安装时必须确认信任；工具调用仍经过策略闸门 |

安装后的文件放在数据目录 `capabilities/skills/<名称>/` 与 `capabilities/plugins/<名称>/`，
启用状态与角色分配记录在 `runtime/capabilities.json`。

## 本机已安装的能力

本机 Pi 环境里已有的 Skill 和扩展（`~/.pi/agent/skills`、`~/.pi/agent/extensions`、`~/.agents/skills`、
通过 `pi install` 安装的包、数据目录下的 `.pi/`）会显示在每个标签页的「本机已安装」区域，不会复制。

- **默认不分配给任何机器人**：机器人不再自动加载本机的 Skill 和扩展，只有在这里勾选了角色，该角色才会加载。
- 分配记录按文件路径保存；文件被删除或移动后会自动失效。
- 列表由 Pi 自己的发现规则生成，与在终端运行 `pi` 时看到的一致；读取扩展的工具名时会执行它的注册函数，
  这与 `pi` 每次启动时的行为相同。
- 本机能力只能分配、启用或停用，不能在这里删除（它们属于你的 Pi 环境）。

## 编写 Skill

```text
api-review/
├── SKILL.md
└── references/
    └── checklist.md
```

`SKILL.md`：

```markdown
---
name: api-review
description: 设计或审查 REST 接口时使用：路径命名、状态码、错误体与分页约定
---

# API 审查

1. 路径用名词复数，层级不超过三层……
2. 详细检查项见 references/checklist.md
```

- `name`：小写字母、数字、连字符，最长 64，安装后不可重名。
- `description`：最重要的一行。系统提示里只列出名称和描述，Agent 靠它判断什么时候去读全文。
- 正文和附带文件只在需要时才被读取，所以可以写得很详细。
- 分配给某个角色后，即使任务设置了读取白名单，该角色仍能读取这个 Skill 目录。

GitHub 来源写法：`owner/repo/子目录@分支`，例如 `anthropics/skills/skills/pdf@main`。

## 编写插件

```text
word-count/
├── plugin.json
└── index.mjs
```

`plugin.json`：

```json
{
  "name": "word-count",
  "description": "统计一段文本的字数，写文案或检查摘要长度时使用",
  "entry": "index.mjs",
  "tools": ["count_words"]
}
```

`index.mjs`（也可以写 `.ts`）：

```js
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "count_words",
    label: "统计字数",
    description: "统计一段文本的字数",
    parameters: Type.Object({ text: Type.String({ description: "要统计的文本" }) }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: String([...params.text].length) }], details: {} };
    },
  });
}
```

- `tools` 必须列出插件注册的全部工具名：只有列出的工具才会加入该角色的可用工具列表。
- `typebox` 由运行时提供，插件无需自带依赖；其他第三方依赖请打包进入口文件。
- 工具调用照常经过策略闸门（任务级工具白名单、敏感文件、删除命令、联网与写入路径）。
  项目经理给某个任务设置了工具白名单时，插件工具也必须在白名单里才能调用。
- 插件代码拥有网关进程的权限：只安装你读过代码、信任来源的插件。
