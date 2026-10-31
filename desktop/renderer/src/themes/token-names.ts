/**
 * 与 styles/tokens.css 的 :root 变量一一对应。
 * 新增 token 时同时更新这里和每个 skins/*.ts；test/skins.test.js 会防止遗漏。
 */
export const tokenNames = [
  "--color-scheme", "--color-primary", "--color-primary-hover", "--color-primary-contrast",
  "--color-bg", "--color-surface", "--color-surface-raised", "--color-surface-sunken",
  "--color-text", "--color-text-muted", "--color-text-subtle", "--color-border", "--color-border-strong",
  "--color-danger", "--color-danger-soft", "--color-success", "--color-success-soft",
  "--color-warning", "--color-warning-soft", "--color-info", "--color-focus-ring", "--color-overlay",
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full",
  "--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-popover",
  "--font-sans", "--font-mono", "--font-size-xs", "--font-size-sm", "--font-size-md", "--font-size-lg", "--font-size-xl", "--font-size-2xl",
  "--line-height-tight", "--line-height-normal", "--line-height-relaxed", "--font-weight-regular", "--font-weight-medium", "--font-weight-semibold", "--font-weight-bold",
  "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-7", "--space-8",
  "--control-h-sm", "--control-h-md", "--control-h-lg",
  "--transition-fast", "--transition-base", "--transition-slow",
  "--z-base", "--z-raised", "--z-sticky", "--z-dropdown", "--z-modal", "--z-toast",
] as const;

export type TokenName = (typeof tokenNames)[number];
export type SkinTokens = Record<TokenName, string>;
