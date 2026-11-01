# 换肤系统

皮肤可以只是对 [`../styles/tokens.css`](../styles/tokens.css) 的全量 CSS 变量覆盖，也可以是携带品牌和布局信息的 skin pack。注册表同时自动发现 `skins/<id>.ts` 和 `skins/<id>/index.ts`，添加皮肤不需要改注册代码。

## 内置皮肤

- `light`：默认浅色
- `dark`：深色
- `warm`：暖调柔和
- `contrast`：高对比
- `forest`：墨绿森林
- `system`：跟随系统（这是一个模式，按系统偏好解析为 `light` 或 `dark`，不是皮肤文件）

## 新增皮肤

1. 颜色皮肤可复制 `skins/light.ts` 到 `skins/<id>.ts`；skin pack 使用如下目录：

   ```text
   skins/<id>/
   ├── index.ts
   └── assets/
       ├── avatar.webp
       ├── typing.webp
       ├── robot.webp
       ├── moods/
       ├── robots/
       └── favicon/
   ```
2. 修改小写、短横线分隔的 `id`、中文 `name`、`description`、`colorScheme` 和四个 `preview` 色块。
3. 为 `tokens` 填写 `tokens.css` 中每一个变量，保存即可被自动发现。

`test/skins.test.js` 会用 `tokens.css` 的实际变量清单检查每个皮肤，漏项、额外项都会失败。`token-names.ts` 同时为 TypeScript 提供同一份受约束的键类型。

## Skin pack 字段

`SkinDefinition` 的基础字段是 `id`、`name`、`description`、`colorScheme`、四个 `preview` 色块和可选 `tokens`。已有颜色皮肤继续提供完整 token 集合。skin pack 还可选提供：

- `assets`: `aiAvatar`、`welcomeIllustration`、`toolRobotIcon`、`logo`、`emptyState`，以及可选 `moods`、`robots`、`favicon`，均为由 Vite 导入的 URL。`moods` 支持 `happy` / `thinking` / `puzzled` / `surprised` / `sleepy`；`robots` 支持 `idle` / `working` / `loading` / `error`；`favicon` 支持 `png32` / `png64` / `png256`。
- `brand`: `displayName`、`slogan`、`welcomeText`、`quickEntries`。每条 quick entry 有 `id`、`label`、可选 `description` / `icon`，以及写入 composer 的 `prompt`。
- `layout`: `homeThreeColumn`、`taskPanel`、`extendable` 布尔开关。

组件通过 `useSkinPack()` 读取当前包；未提供的字段必须回退到原产品 UI 和 “Agent 工作台” 名称。素材使用 Vite URL 导入；未交付的品牌素材不绘制角色替代品，应省略该 slot 或使用清晰命名的中性 `placeholder-*.svg`。

## Pear Agent IP 素材

`pear` 阶段 1 使用雪梨交付的真实 IP 图（源仓库为 Super-Sydney `origin/main`）。下表中的 WebP 均已在导入前优化：

| Slot | 包内文件 | 来源 |
| --- | --- | --- |
| `aiAvatar` | `skins/pear/assets/avatar.webp` | Super-Sydney `origin/main` `desktop/assets/ip-presets/sydney/avatar.png`，优化为 WebP |
| `logo` | `skins/pear/assets/avatar.webp` | Super-Sydney `origin/main` `desktop/assets/ip-presets/sydney/avatar.png`，优化为 WebP |
| `welcomeIllustration` | `skins/pear/assets/typing.webp` | Super-Sydney `origin/main` `desktop/assets/ip-presets/sydney/typing.png`，优化为 WebP |
| `toolRobotIcon` | `skins/pear/assets/robot.webp` | Super-Sydney `origin/main` `desktop/assets/ip-presets/sydney/team.png` 中持铅笔机器人裁切，优化为 WebP |
| 任务面板空状态 | `skins/pear/assets/pointing.webp` | Super-Sydney `origin/main` `desktop/assets/ip-presets/sydney/pointing.png`，优化为 WebP |
| `moods.*` | `skins/pear/assets/moods/mood-*.webp` | Pear 已交付状态表情，任务状态的紧凑视觉补充 |
| `robots.*` | `skins/pear/assets/robots/robot-*.webp` | Pear 已交付工具执行状态机器人 |
| `favicon.*` | `skins/pear/assets/favicon/favicon-{32,64,256}.png` | Pear 已交付页签图标 |

Pear 仅在素材可用时绘制这些扩展：侧栏最近任务保留既有 `.status-dot` 和状态文字，并在其旁显示 `moods`；任务面板状态 chip 同样显示表情。工具调用的汇总行使用状态机器人，单项等待结果时使用 loading 机器人，缺少某一状态资源时回退到 `toolRobotIcon`。其他皮肤不显示这些新增图像。

| 任务状态 token | 心情 |
| --- | --- |
| `pending` | `sleepy` |
| `planning` | `thinking` |
| `running` | `thinking` |
| `waiting-approval` | `puzzled` |
| `completed` | `happy` |
| `failed` | `surprised` |
| `cancelled` | `sleepy` |

`SkinProvider` 在 Pear 激活时将 `favicon.png32` 写入主 `rel="icon"`，并提供 64px 变体；已有的 `apple-touch-icon` 使用 256px 变体。离开含 favicon 的 skin 时会恢复进入 Pear 前的链接属性并删除临时链接。Electron 原生窗口图标仍由主进程在创建窗口时决定，未通过 IPC 改动。

### 缺失素材

- 三视图（正面／侧面／背面）：尚未提供；阶段 1 UI 未使用，建议透明背景原图。
- 额外空状态插画：项目、历史、失败等空状态可用；建议约 240–320px、透明背景。

## 首屏与偏好

用户选择保存在 `localStorage["multyagent.skin"]`；解析后的 CSS 保存在 `multyagent.skin.css`。`index.html` 在 React 挂载前设置 `data-skin` 并复用缓存样式，避免已选择皮肤再次打开时闪白。`system` 会监听 `prefers-color-scheme` 的变化。

## 后续外观选项

`registry.ts` 已导出 `skinOptionLayers` 和 `SkinOptionLayer`：后续强调色、字体或密度偏好可以作为 `Partial<SkinTokens>` 叠加在基础皮肤上，而无需破坏皮肤的全量 token 契约。当前工作区没有 `/workspace/zxl-wip`，因此没有移植未提交 appearance WIP 的具体数值。
