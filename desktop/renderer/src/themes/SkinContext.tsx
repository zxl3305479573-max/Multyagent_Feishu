import { createContext, useContext, useEffect, useState } from "react";
import { applyStoredSkin } from "./apply";
import { getSkin } from "./registry";
import type { SkinDefinition } from "./types";

const SkinContext = createContext<SkinDefinition>(getSkin("light"));

export function SkinProvider({ children }: { children: React.ReactNode }) {
  const [skin, setSkin] = useState(() => applyStoredSkin());
  useEffect(() => {
    const sync = (event: Event) => setSkin((event as CustomEvent<SkinDefinition>).detail || getSkin(document.documentElement.dataset.skin));
    window.addEventListener("multyagent:skin-change", sync);
    return () => window.removeEventListener("multyagent:skin-change", sync);
  }, []);
  useEffect(() => { document.title = skin.brand?.displayName || "Agent 工作台"; }, [skin]);
  useEffect(() => {
    const favicon = skin.assets?.favicon;
    if (!favicon?.png32) return;

    type OriginalIcon = { link: HTMLLinkElement; rel: string | null; href: string | null; sizes: string | null; type: string | null };
    const originals: OriginalIcon[] = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]')]
      .map((link) => ({ link, rel: link.getAttribute("rel"), href: link.getAttribute("href"), sizes: link.getAttribute("sizes"), type: link.getAttribute("type") }));
    const created: HTMLLinkElement[] = [];
    const setIcon = (link: HTMLLinkElement, href: string, sizes: string) => {
      link.href = href;
      link.sizes = sizes;
      link.type = "image/png";
    };
    const iconLinks = originals.filter(({ rel }) => rel?.split(/\s+/).includes("icon"));
    const appleLinks = originals.filter(({ rel }) => rel === "apple-touch-icon");
    const primary = iconLinks[0]?.link || document.head.appendChild(document.createElement("link"));
    if (!iconLinks.length) { primary.rel = "icon"; created.push(primary); }
    setIcon(primary, favicon.png32, "32x32");
    const size64 = iconLinks.find(({ sizes }) => sizes === "64x64")?.link || document.head.appendChild(document.createElement("link"));
    if (!iconLinks.some(({ link }) => link === size64)) { size64.rel = "icon"; created.push(size64); }
    setIcon(size64, favicon.png64 || favicon.png32, "64x64");
    for (const { link } of appleLinks) setIcon(link, favicon.png256 || favicon.png64 || favicon.png32, "256x256");

    return () => {
      for (const original of originals) {
        for (const [name, value] of Object.entries({ rel: original.rel, href: original.href, sizes: original.sizes, type: original.type })) {
          if (value === null) original.link.removeAttribute(name);
          else original.link.setAttribute(name, value);
        }
      }
      for (const link of created) link.remove();
    };
  }, [skin]);
  return <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>;
}

/** The active pack; absent fields intentionally fall back to the original product UI. */
export function useSkinPack() { return useContext(SkinContext); }
export const useSkin = useSkinPack;
