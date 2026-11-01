import type { SkinDefinition } from "../types";

const skin = {
  id: "light", name: "默认浅色", description: "暖白基调、清晰克制的日间工作界面", colorScheme: "light", preview: ["#f7f5f2", "#fffefd", "#3e6ee8", "#242526"],
  tokens: {
    "--color-scheme": "light", "--color-primary": "#3e6ee8", "--color-primary-hover": "#2f5bcf", "--color-primary-contrast": "#ffffff", "--color-primary-soft": "#edf2ff", "--color-primary-border": "#c9d7ff", "--color-action": "#242526", "--color-action-hover": "#111213", "--color-action-contrast": "#fff",
    "--color-bg": "#f7f5f2", "--color-surface": "#f0eeea", "--color-surface-raised": "#fffefd", "--color-surface-sunken": "#ebe8e3", "--color-surface-hover": "#e8e5df",
    "--color-text": "#242424", "--color-text-muted": "#716e69", "--color-text-subtle": "#98948d", "--color-border": "#e2ded7", "--color-border-strong": "#cfc9bf",
    "--color-danger": "#ca4d4a", "--color-danger-soft": "#fff0ef", "--color-success": "#25845b", "--color-success-soft": "#eaf7f0", "--color-warning": "#b47b20", "--color-warning-soft": "#fff6e5", "--color-info": "#3e6ee8", "--color-focus-ring": "#3e6ee8", "--color-overlay": "rgba(30, 29, 27, .42)", "--color-code-bg": "#242526", "--color-code-border": "#3b3b39", "--color-code-text": "#f4f1ed",
    "--radius-sm": "8px", "--radius-md": "12px", "--radius-lg": "16px", "--radius-xl": "22px", "--radius-full": "999px",
    "--shadow-sm": "0 1px 2px rgba(43, 39, 34, .04), 0 3px 10px rgba(43, 39, 34, .04)", "--shadow-md": "0 10px 30px rgba(43, 39, 34, .08)", "--shadow-lg": "0 24px 70px rgba(43, 39, 34, .20)", "--shadow-popover": "0 12px 34px rgba(43, 39, 34, .12)",
    "--font-sans": "Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', -apple-system, BlinkMacSystemFont, sans-serif", "--font-mono": "'Cascadia Mono', ui-monospace, Consolas, monospace", "--font-size-xs": "11px", "--font-size-sm": "12px", "--font-size-md": "13px", "--font-size-lg": "15px", "--font-size-xl": "18px", "--font-size-2xl": "24px", "--line-height-tight": "1.2", "--line-height-normal": "1.5", "--line-height-relaxed": "1.65", "--font-weight-regular": "400", "--font-weight-medium": "500", "--font-weight-semibold": "600", "--font-weight-bold": "700",
    "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "20px", "--space-6": "24px", "--space-7": "28px", "--space-8": "32px", "--control-h-sm": "32px", "--control-h-md": "36px", "--control-h-lg": "40px", "--transition-fast": "120ms ease", "--transition-base": "180ms cubic-bezier(.2, .7, .2, 1)", "--transition-slow": "260ms cubic-bezier(.2, .7, .2, 1)", "--z-base": "0", "--z-raised": "1", "--z-sticky": "2", "--z-dropdown": "20", "--z-modal": "40", "--z-toast": "60",
  },
} satisfies SkinDefinition;

export default skin;
