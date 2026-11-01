import { getSkin } from "./registry";
import type { SkinDefinition } from "./types";

export const SKIN_STORAGE_KEY = "multyagent.skin";
export const SKIN_CSS_STORAGE_KEY = "multyagent.skin.css";
export const SKIN_CSS_ID_STORAGE_KEY = "multyagent.skin.css.id";
export type SkinChoice = string | "system";

let mediaQuery: MediaQueryList | undefined;
let listening = false;

function storageGet(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode can deny storage */ }
}

export function resolveSkinId(choice: SkinChoice = getSavedSkinChoice()) {
  if (choice !== "system") return getSkin(choice).id;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getSavedSkinChoice(): SkinChoice {
  const choice = storageGet(SKIN_STORAGE_KEY);
  return choice === "system" || Boolean(choice) ? choice! : "light";
}

export function skinCss(skin: SkinDefinition) {
  return `[data-skin="${skin.id}"]{${Object.entries(skin.tokens || {}).map(([name, value]) => `${name}:${value};`).join("")}}`;
}

function styleElement() {
  let style = document.getElementById("multyagent-skin") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "multyagent-skin";
    document.head.append(style);
  }
  return style;
}

/** 应用指定皮肤；预览时不写入偏好或首屏缓存。 */
export function applySkin(id: string, cache = true) {
  const skin = getSkin(id);
  const css = skinCss(skin);
  document.documentElement.dataset.skin = skin.id;
  styleElement().textContent = css;
  window.dispatchEvent(new CustomEvent("multyagent:skin-change", { detail: skin }));
  if (cache) {
    storageSet(SKIN_CSS_STORAGE_KEY, css);
    storageSet(SKIN_CSS_ID_STORAGE_KEY, skin.id);
  }
  return skin;
}

export function applySkinChoice(choice: SkinChoice, persist = true) {
  if (persist) storageSet(SKIN_STORAGE_KEY, choice);
  const skin = applySkin(resolveSkinId(choice), persist);
  if (choice === "system") listenForSystemSkin();
  return skin;
}

function listenForSystemSkin() {
  if (listening || !window.matchMedia) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    if (getSavedSkinChoice() === "system") applySkinChoice("system", false);
  });
  listening = true;
}

/** React 挂载前调用，接管 index.html 的缓存样式并安装 system 监听。 */
export function applyStoredSkin() {
  const choice = getSavedSkinChoice();
  return applySkinChoice(choice, false);
}
