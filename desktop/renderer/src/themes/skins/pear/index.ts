import type { SkinDefinition } from "../../types";
import avatar from "./assets/avatar.webp";
import logo from "./assets/avatar.webp";
import robot from "./assets/robot.webp";
import welcome from "./assets/typing.webp";

const skin = {
  id: "pear", name: "Pear Agent", description: "雪梨的奶油科技工作台（阶段 1）", colorScheme: "light", preview: ["#FFFCF4", "#FFF5C9", "#79C9F4", "#34405B"],
  assets: { aiAvatar: avatar, welcomeIllustration: welcome, toolRobotIcon: robot, logo },
  brand: { displayName: "Pear Agent", slogan: "Think · Act · Deliver", welcomeText: "嗨，今天想完成什么任务？", quickEntries: [
    { id: "code", label: "编程开发", description: "实现、排错与代码审查", icon: "⌘", prompt: "请帮我开发这个功能：\n目标：\n技术约束：\n验收标准：" },
    { id: "research", label: "信息研究", description: "检索、比较与提炼结论", icon: "⌕", prompt: "请研究以下问题，并给出可信来源、对比结论与下一步建议：\n" },
    { id: "document", label: "文档处理", description: "撰写、整理与结构化", icon: "▤", prompt: "请协助处理这份文档：\n背景：\n期望产出：\n" },
    { id: "automation", label: "自动化任务", description: "规划流程并执行重复工作", icon: "↻", prompt: "请设计并执行这个自动化任务：\n触发条件：\n步骤：\n完成标准：" },
  ] },
  layout: { homeThreeColumn: true, taskPanel: true, extendable: true },
  tokens: {
    "--color-scheme": "light", "--color-primary": "#4A9FD0", "--color-primary-hover": "#3288bc", "--color-primary-contrast": "#34405B", "--color-primary-soft": "#e7f6ff", "--color-primary-border": "#a9dcf7", "--color-action": "#34405B", "--color-action-hover": "#242e44", "--color-action-contrast": "#fffdf4", "--color-bg": "#FFFCF4", "--color-surface": "#FFF5C9", "--color-surface-raised": "#fffef9", "--color-surface-sunken": "#f9f1da", "--color-surface-hover": "#f5e8bc", "--color-text": "#34405B", "--color-text-muted": "#64708a", "--color-text-subtle": "#9299a8", "--color-border": "#e8dfc4", "--color-border-strong": "#cfc39e", "--color-danger": "#c65557", "--color-danger-soft": "#fff0ed", "--color-success": "#398969", "--color-success-soft": "#e8f7ef", "--color-warning": "#a87920", "--color-warning-soft": "#fff5dc", "--color-info": "#4A9FD0", "--color-focus-ring": "#4A9FD0", "--color-overlay": "rgba(52,64,91,.42)", "--color-code-bg": "#34405B", "--color-code-border": "#46536f", "--color-code-text": "#f7fbff", "--status-pending": "#778196", "--status-planning": "#806bb2", "--status-running": "#4A9FD0", "--status-waiting-approval": "#a87920", "--status-completed": "#398969", "--status-failed": "#c65557", "--status-cancelled": "#8b8f99", "--status-pending-bg": "#eff1f5", "--status-planning-bg": "#f1ecff", "--status-running-bg": "#e7f6ff", "--status-waiting-approval-bg": "#fff5dc", "--status-completed-bg": "#e8f7ef", "--status-failed-bg": "#fff0ed", "--status-cancelled-bg": "#eff0f2", "--radius-sm": "10px", "--radius-md": "15px", "--radius-lg": "20px", "--radius-xl": "28px", "--radius-full": "999px", "--shadow-sm": "0 3px 12px rgba(80,90,105,.07)", "--shadow-md": "0 12px 32px rgba(80,90,105,.10)", "--shadow-lg": "0 24px 64px rgba(80,90,105,.16)", "--shadow-popover": "0 12px 34px rgba(80,90,105,.14)", "--font-sans": "Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif", "--font-mono": "'Cascadia Mono', ui-monospace, Consolas, monospace", "--font-size-xs": "11px", "--font-size-sm": "12px", "--font-size-md": "13px", "--font-size-lg": "15px", "--font-size-xl": "18px", "--font-size-2xl": "24px", "--line-height-tight": "1.2", "--line-height-normal": "1.5", "--line-height-relaxed": "1.65", "--font-weight-regular": "400", "--font-weight-medium": "500", "--font-weight-semibold": "650", "--font-weight-bold": "700", "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "20px", "--space-6": "24px", "--space-7": "28px", "--space-8": "32px", "--control-h-sm": "32px", "--control-h-md": "36px", "--control-h-lg": "40px", "--transition-fast": "120ms ease", "--transition-base": "180ms cubic-bezier(.2,.7,.2,1)", "--transition-slow": "260ms cubic-bezier(.2,.7,.2,1)", "--z-base": "0", "--z-raised": "1", "--z-sticky": "2", "--z-dropdown": "20", "--z-modal": "40", "--z-toast": "60"
  },
} satisfies SkinDefinition;
export default skin;
