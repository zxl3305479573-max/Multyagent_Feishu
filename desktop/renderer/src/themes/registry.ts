import type { SkinDefinition, SkinOptionLayer } from "./types";

const modules = import.meta.glob<{ default: SkinDefinition }>("./skins/*.ts", { eager: true });

const builtinOrder = ["light", "dark", "warm", "contrast", "forest"];
export const skins = Object.values(modules)
  .map((module) => module.default)
  .sort((left, right) => {
    const leftOrder = builtinOrder.indexOf(left.id);
    const rightOrder = builtinOrder.indexOf(right.id);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder) || left.id.localeCompare(right.id, "zh-CN");
  });

const ids = new Set<string>();
for (const skin of skins) {
  if (!/^[a-z0-9-]+$/.test(skin.id)) throw new Error(`皮肤 id 只能使用小写字母、数字和连字符：${skin.id}`);
  if (ids.has(skin.id)) throw new Error(`重复的皮肤 id：${skin.id}`);
  ids.add(skin.id);
}

export const skinsById = new Map(skins.map((skin) => [skin.id, skin]));
export type SkinId = (typeof skins)[number]["id"];

/** 空列表是有意的：appearance WIP 不在当前工作区，后续可在此注册强调色/字体/密度层。 */
export const skinOptionLayers: readonly SkinOptionLayer[] = [];

export function getSkin(id: string | null | undefined): SkinDefinition {
  return skinsById.get(id || "") || skinsById.get("light") || skins[0];
}
