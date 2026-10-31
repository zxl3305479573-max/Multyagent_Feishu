import type { SkinTokens } from "./token-names";

export type SkinDefinition = {
  id: string;
  name: string;
  description: string;
  colorScheme: "light" | "dark";
  preview: readonly [string, string, string, string];
  tokens: SkinTokens;
};

/** 为后续的强调色、字体与密度偏好预留的可叠加层，不改变基础皮肤契约。 */
export type SkinOptionLayer = {
  id: string;
  name: string;
  description: string;
  tokens: Partial<SkinTokens>;
};
