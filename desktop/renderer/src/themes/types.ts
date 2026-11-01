import type { ReactNode } from "react";
import type { SkinTokens } from "./token-names";

export type SkinMoodAssets = { happy?: string; thinking?: string; puzzled?: string; surprised?: string; sleepy?: string };
export type SkinRobotAssets = { idle?: string; working?: string; loading?: string; error?: string };
export type SkinFaviconAssets = { png32?: string; png64?: string; png256?: string };

export type SkinAssets = {
  aiAvatar?: string;
  welcomeIllustration?: string;
  /** Generic fallback for packs that have not supplied a state-specific robot. */
  toolRobotIcon?: string;
  logo?: string;
  emptyState?: string;
  emptyConversation?: string;
  emptyTasks?: string;
  moods?: SkinMoodAssets;
  robots?: SkinRobotAssets;
  favicon?: SkinFaviconAssets;
};
export type SkinQuickEntry = { id: string; label: string; description?: string; icon?: ReactNode; prompt: string };
export type SkinBrand = { displayName?: string; slogan?: string; welcomeText?: string; quickEntries?: SkinQuickEntry[] };
export type SkinLayout = { homeThreeColumn?: boolean; taskPanel?: boolean; extendable?: boolean };

export type SkinDefinition = {
  id: string;
  name: string;
  description: string;
  colorScheme: "light" | "dark";
  preview: readonly [string, string, string, string];
  /** Color-only skins keep this full token map; packs may omit it and inherit defaults. */
  tokens?: SkinTokens;
  assets?: SkinAssets;
  brand?: SkinBrand;
  layout?: SkinLayout;
};

/** 为后续的强调色、字体与密度偏好预留的可叠加层，不改变基础皮肤契约。 */
export type SkinOptionLayer = {
  id: string;
  name: string;
  description: string;
  tokens: Partial<SkinTokens>;
};
