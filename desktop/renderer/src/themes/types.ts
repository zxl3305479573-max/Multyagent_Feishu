import type { ReactNode } from "react";
import type { SkinTokens } from "./token-names";

export type SkinAssets = { aiAvatar?: string; welcomeIllustration?: string; toolRobotIcon?: string; logo?: string; emptyState?: string };
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
