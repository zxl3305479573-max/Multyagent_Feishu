# 换肤系统

皮肤是对 [`../styles/tokens.css`](../styles/tokens.css) 全量 CSS 变量契约的一组覆盖。注册表以 `import.meta.glob('./skins/*.ts', { eager: true })` 自动发现文件：添加皮肤不需要改注册代码。

## 内置皮肤

- `light`：默认浅色
- `dark`：深色
- `warm`：暖调柔和
- `contrast`：高对比
- `forest`：墨绿森林
- `system`：跟随系统（这是一个模式，按系统偏好解析为 `light` 或 `dark`，不是皮肤文件）

## 新增皮肤

1. 复制 `skins/light.ts` 到 `skins/<id>.ts`。
2. 修改小写、短横线分隔的 `id`、中文 `name`、`description`、`colorScheme` 和四个 `preview` 色块。
3. 为 `tokens` 填写 `tokens.css` 中每一个变量，保存即可被自动发现。

`test/skins.test.js` 会用 `tokens.css` 的实际变量清单检查每个皮肤，漏项、额外项都会失败。`token-names.ts` 同时为 TypeScript 提供同一份受约束的键类型。

## 首屏与偏好

用户选择保存在 `localStorage["multyagent.skin"]`；解析后的 CSS 保存在 `multyagent.skin.css`。`index.html` 在 React 挂载前设置 `data-skin` 并复用缓存样式，避免已选择皮肤再次打开时闪白。`system` 会监听 `prefers-color-scheme` 的变化。

## 后续外观选项

`registry.ts` 已导出 `skinOptionLayers` 和 `SkinOptionLayer`：后续强调色、字体或密度偏好可以作为 `Partial<SkinTokens>` 叠加在基础皮肤上，而无需破坏皮肤的全量 token 契约。当前工作区没有 `/workspace/zxl-wip`，因此没有移植未提交 appearance WIP 的具体数值。
