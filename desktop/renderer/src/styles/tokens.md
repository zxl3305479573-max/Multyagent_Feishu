# 共享设计 Token 契约

`tokens.css` 是渲染器所有组件和皮肤共享的视觉契约。它只包含一个默认 `:root` 块；组件应通过 CSS 自定义属性取值，不能再写硬编码颜色。尺寸、间距、圆角、阴影、字号和层级也应优先使用本文件的 token。

皮肤通过 `html[data-skin="<id>"]` 覆盖同名变量。例如：

```css
html[data-skin="night"] {
  --color-scheme: dark;
  --color-bg: #1d1f23;
  --color-text: #f2f3f5;
}
```

不要在组件中根据皮肤 ID 分支或复制颜色；新增皮肤必须完整覆盖其需要改变的 token，并维持变量语义。

## 颜色

| Token | 含义 |
| --- | --- |
| `--color-scheme` | 浏览器原生控件的 `light` 或 `dark` 色彩方案。 |
| `--color-primary` | 主操作、选中状态和品牌强调色。 |
| `--color-primary-hover` | 主操作悬停色。 |
| `--color-primary-contrast` | 置于主色上的前景文字/图标色。 |
| `--color-primary-soft` / `--color-primary-border` | 主色相关的弱强调背景和边界。 |
| `--color-action` / `--color-action-hover` / `--color-action-contrast` | 深色主操作（胶囊按钮）及其悬停、前景色；蓝色 `--color-primary` 仍只承担选中、链接和焦点强调。 |
| `--color-bg` | 应用最底层背景。 |
| `--color-surface` | 普通、次级表面。 |
| `--color-surface-raised` | 卡片、菜单、输入框等抬升表面。 |
| `--color-surface-sunken` | 侧栏等凹陷表面。 |
| `--color-surface-hover` | 可交互表面的悬停背景。 |
| `--color-text` | 默认主要文本。 |
| `--color-text-muted` | 次要说明文本。 |
| `--color-text-subtle` | 最弱的辅助文本。 |
| `--color-border` | 默认边框和分隔线。 |
| `--color-border-strong` | 悬停或需要更清晰边界的边框。 |
| `--color-danger` | 失败、删除和危险操作。 |
| `--color-danger-soft` | 危险状态的浅色背景。 |
| `--color-success` | 成功和完成状态。 |
| `--color-success-soft` | 成功状态的浅色背景。 |
| `--color-warning` | 警告和暂停状态。 |
| `--color-warning-soft` | 警告状态的浅色背景。 |
| `--color-info` | 信息提示色；默认与主色一致。 |
| `--color-focus-ring` | 键盘焦点外圈。 |
| `--color-overlay` | 遮罩层背景。 |
| `--color-code-bg` / `--color-code-border` / `--color-code-text` | 日志、代码块等深色语义表面。 |
| `--status-pending` / `--status-planning` / `--status-running` / `--status-waiting-approval` / `--status-completed` / `--status-failed` / `--status-cancelled` | 任务视图层状态的前景色；不改变后端存储的状态值。 |
| 上述每个 token 的 `-bg` 变体 | 相应任务状态的浅色背景。 |

## 圆角与阴影

| Token | 含义 |
| --- | --- |
| `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` | 从小到大的常规圆角。 |
| `--radius-full` | 胶囊和圆形元素的最大圆角。 |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | 从轻到重的通用投影。 |
| `--shadow-popover` | 菜单、浮层和弹出内容的投影。 |

## 字体

| Token | 含义 |
| --- | --- |
| `--font-sans` / `--font-mono` | 界面字体栈和等宽字体栈。 |
| `--font-size-xs` / `--font-size-sm` / `--font-size-md` / `--font-size-lg` / `--font-size-xl` / `--font-size-2xl` | 从辅助标签到页面标题的字号阶梯。 |
| `--line-height-tight` / `--line-height-normal` / `--line-height-relaxed` | 紧凑、默认和正文行高。 |
| `--font-weight-regular` / `--font-weight-medium` / `--font-weight-semibold` / `--font-weight-bold` | 常规到粗体字重。 |

## 布局、控件、动效和层级

| Token | 含义 |
| --- | --- |
| `--space-1` … `--space-8` | 4px 网格的间距阶梯（4px 至 32px）。 |
| `--control-h-sm` / `--control-h-md` / `--control-h-lg` | 小、中、大控件高度。 |
| `--transition-fast` / `--transition-base` / `--transition-slow` | 快速、默认、较慢的过渡时间与缓动。 |
| `--z-base` / `--z-raised` / `--z-sticky` / `--z-dropdown` / `--z-modal` / `--z-toast` | 从常规内容到通知的层级。组件不得随意使用裸 `z-index` 数值。 |

新增 token 前，先确认现有语义不能表达该场景；命名应描述用途而不是具体颜色或某个组件。
