import type { ResolvedSkinDefinition, SkinBrand, SkinDefinition, SkinQuickEntry } from "./types";

const defaultQuickEntries: SkinQuickEntry[] = [
  {
    id: "code",
    label: "编程开发",
    description: "实现、排错与代码审查",
    icon: "⌘",
    prompt: "请帮我开发这个功能：\n目标：\n技术约束：\n验收标准：",
  },
  {
    id: "research",
    label: "信息研究",
    description: "检索、比较与提炼结论",
    icon: "⌕",
    prompt: "请研究以下问题，并给出可信来源、对比结论与下一步建议：\n",
  },
  {
    id: "document",
    label: "文档处理",
    description: "撰写、整理与结构化",
    icon: "▤",
    prompt: "请协助处理这份文档：\n背景：\n期望产出：\n",
  },
  {
    id: "automation",
    label: "自动化任务",
    description: "规划流程并执行重复工作",
    icon: "↻",
    prompt: "请设计并执行这个自动化任务：\n触发条件：\n步骤：\n完成标准：",
  },
];

export const DEFAULT_SKIN_BRAND: NonNullable<ResolvedSkinDefinition["brand"]> = {
  displayName: "Agent 工作台",
  slogan: "Think · Plan · Deliver",
  welcomeText: "今天想完成什么任务？",
  welcomeDescription: "描述目标和约束，Agent 会规划步骤、调用工具并持续汇报执行进度。",
  quickEntries: defaultQuickEntries,
};

/** Neutral, non-IP fallback assets. Components draw a CSS monogram when an image is absent. */
export const DEFAULT_SKIN_ASSETS: ResolvedSkinDefinition["assets"] = {};

export function resolveSkinDefinition(skin: SkinDefinition): ResolvedSkinDefinition {
  const brand: SkinBrand = skin.brand || {};
  return {
    ...skin,
    assets: { ...DEFAULT_SKIN_ASSETS, ...(skin.assets || {}) },
    brand: {
      displayName: brand.displayName || DEFAULT_SKIN_BRAND.displayName,
      slogan: brand.slogan || DEFAULT_SKIN_BRAND.slogan,
      welcomeText: brand.welcomeText || DEFAULT_SKIN_BRAND.welcomeText,
      welcomeDescription: brand.welcomeDescription || DEFAULT_SKIN_BRAND.welcomeDescription,
      quickEntries: brand.quickEntries?.length ? brand.quickEntries : DEFAULT_SKIN_BRAND.quickEntries,
    },
  };
}
