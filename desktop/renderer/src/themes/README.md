# 换肤系统

皮肤可以只是对 [`../styles/tokens.css`](../styles/tokens.css) 的全量 CSS 变量覆盖，也可以是携带品牌、文案与素材的 skin pack。所有皮肤共用同一套三栏工作台布局；注册表同时自动发现 `skins/<id>.ts` 和 `skins/<id>/index.ts`，添加皮肤不需要改注册代码。

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
3. 为 `tokens` 填写 `tokens.css` 中每一个变量，保存即可被自动发现。未提供品牌或素材的皮肤会自动合并 [`defaults.ts`](./defaults.ts) 中的中性默认值。

`test/skins.test.js` 会用 `tokens.css` 的实际变量清单检查每个皮肤，漏项、额外项都会失败。`token-names.ts` 同时为 TypeScript 提供同一份受约束的键类型。

## Skin pack 字段

`SkinDefinition` 的基础字段是 `id`、`name`、`description`、`colorScheme`、四个 `preview` 色块和可选 `tokens`。已有颜色皮肤继续提供完整 token 集合。skin pack 还可选提供：

- `assets`: `aiAvatar`、`welcomeIllustration`、`toolRobotIcon`、`logo`、`emptyState`，以及可选 `moods`、`robots`、`favicon`，均为由 Vite 导入的 URL。`moods` 支持 `happy` / `thinking` / `puzzled` / `surprised` / `sleepy`；`robots` 支持 `idle` / `working` / `loading` / `error`；`favicon` 支持 `png32` / `png64` / `png256`。
- `brand`: `displayName`、`slogan`、`welcomeText`、`welcomeDescription`、`quickEntries`。每条 quick entry 有 `id`、`label`、可选 `description` / `icon`，以及写入 composer 的 `prompt`。

皮肤不再声明布局开关。`HomeWorkspace`、`TaskPanel`、计划卡、状态色、空状态、AI 消息头像、心情与机器人槽位都由同一组通用组件渲染；组件只通过 `useSkinPack()` 读取已经合并默认值的 tokens、素材和文案。非 Pear 皮肤没有 IP 素材时显示 CSS 字母头像/中性占位，不会绘制角色替代品。

## 统一布局

- 三栏首页：左侧导航、中间欢迎语/快捷入口/输入框、右侧任务面板。
- 任务页：中间保留对话与输入框，右侧继续展示当前任务、进度、步骤时间线、工具调用和日志。
- `TaskPanel` 由真实任务事件推导进度与时间线；`status-*` token 驱动全部状态颜色。
- 宽度约 1024px 时右栏移到内容下方，侧栏在 720px 以下变为抽屉。

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

`SkinProvider` 在含 favicon 的皮肤激活时写入主 `rel="icon"`，并提供 64px 变体；已有的 `apple-touch-icon` 使用 256px 变体。离开含 favicon 的皮肤时会恢复原链接属性并删除临时链接。Electron 原生窗口/托盘图标通过既有 `desktop:window:set-skin` IPC 切换：Pear 使用 Pear favicon，其他皮肤使用默认图标。

### 需要雪梨给图

- 三视图（正面／侧面／背面）：建议每张 1200×1600px，透明 PNG/WebP。
- 打字、挥手、庆祝 pose：建议每张 1000×1400px，透明 PNG/WebP。
- 团队空状态插画：建议 1200×900px，透明 PNG/WebP。
- 阶段四页面插画（记忆、技能、文件、历史、权限、监控）：建议每张 1200×800px，透明 PNG/WebP；未交付前使用统一中性占位。

## 首屏与偏好

用户选择保存在 `localStorage["multyagent.skin"]`；解析后的 CSS 保存在 `multyagent.skin.css`。`index.html` 在 React 挂载前设置 `data-skin` 并复用缓存样式，避免已选择皮肤再次打开时闪白。`system` 会监听 `prefers-color-scheme` 的变化。

## 后续外观选项

`registry.ts` 已导出 `skinOptionLayers` 和 `SkinOptionLayer`：后续强调色、字体或密度偏好可以作为 `Partial<SkinTokens>` 叠加在基础皮肤上，而无需破坏皮肤的全量 token 契约。当前工作区没有 `/workspace/zxl-wip`，因此没有移植未提交 appearance WIP 的具体数值。
