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
  return <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>;
}

/** The active pack; absent fields intentionally fall back to the original product UI. */
export function useSkinPack() { return useContext(SkinContext); }
export const useSkin = useSkinPack;
