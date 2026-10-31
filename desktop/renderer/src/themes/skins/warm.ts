import type { SkinDefinition } from "../types";

const skin = {
  id: "warm", name: "暖调柔和", description: "柔和米杏色，适合长时间阅读", colorScheme: "light", preview: ["#fffaf2", "#f8efe3", "#b85c38", "#392d27"],
  tokens: {
    "--color-scheme": "light", "--color-primary": "#b85c38", "--color-primary-hover": "#934427", "--color-primary-contrast": "#ffffff", "--color-bg": "#fffaf2", "--color-surface": "#f8efe3", "--color-surface-raised": "#fffdf9", "--color-surface-sunken": "#f2e6d7", "--color-text": "#392d27", "--color-text-muted": "#6f5c50", "--color-text-subtle": "#9d887a", "--color-border": "#e4d4c4", "--color-border-strong": "#cbb39f", "--color-danger": "#b94040", "--color-danger-soft": "#fbe9e5", "--color-success": "#347a55", "--color-success-soft": "#e7f3ea", "--color-warning": "#9a6818", "--color-warning-soft": "#fbf0d7", "--color-info": "#9d593e", "--color-focus-ring": "#b85c38", "--color-overlay": "rgba(57, 45, 39, .42)",
    "--radius-sm": "7px", "--radius-md": "10px", "--radius-lg": "15px", "--radius-xl": "20px", "--radius-full": "999px", "--shadow-sm": "0 1px 3px rgba(90, 62, 43, .08)", "--shadow-md": "0 7px 22px rgba(90, 62, 43, .10)", "--shadow-lg": "0 20px 52px rgba(90, 62, 43, .18)", "--shadow-popover": "0 7px 22px rgba(90, 62, 43, .10)",
    "--font-sans": "Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', -apple-system, BlinkMacSystemFont, sans-serif", "--font-mono": "'Cascadia Mono', ui-monospace, Consolas, monospace", "--font-size-xs": "11px", "--font-size-sm": "12px", "--font-size-md": "13px", "--font-size-lg": "15px", "--font-size-xl": "18px", "--font-size-2xl": "24px", "--line-height-tight": "1.2", "--line-height-normal": "1.55", "--line-height-relaxed": "1.7", "--font-weight-regular": "400", "--font-weight-medium": "500", "--font-weight-semibold": "600", "--font-weight-bold": "700", "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "20px", "--space-6": "24px", "--space-7": "28px", "--space-8": "32px", "--control-h-sm": "30px", "--control-h-md": "34px", "--control-h-lg": "36px", "--transition-fast": "120ms ease", "--transition-base": "180ms cubic-bezier(.2, .7, .2, 1)", "--transition-slow": "260ms cubic-bezier(.2, .7, .2, 1)", "--z-base": "0", "--z-raised": "1", "--z-sticky": "2", "--z-dropdown": "20", "--z-modal": "40", "--z-toast": "60",
  },
} satisfies SkinDefinition;

export default skin;
