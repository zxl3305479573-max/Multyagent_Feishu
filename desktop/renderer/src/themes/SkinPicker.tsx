import { useState } from "react";
import { applySkin, applySkinChoice, resolveSkinId, type SkinChoice } from "./apply";
import { skins } from "./registry";
import type { SkinDefinition } from "./types";

type Props = { choice: SkinChoice; onChange: (choice: SkinChoice) => void };

function Swatches({ colors }: { colors: readonly string[] }) {
  return <span className="skin-swatches" aria-hidden="true">{colors.map((color) => <i key={color} style={{ background: color }} />)}</span>;
}

function SkinCard({ skin, selected, onSelect, onPreview, onRestore }: {
  skin: SkinDefinition; selected: boolean; onSelect: () => void; onPreview: () => void; onRestore: () => void;
}) {
  return <button type="button" className={`skin-card ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={onSelect} onMouseEnter={onPreview} onFocus={onPreview} onMouseLeave={onRestore} onBlur={onRestore}>
    {skin.assets?.aiAvatar ? <img className="skin-card-avatar" src={skin.assets.aiAvatar} alt="" /> : <Swatches colors={skin.preview} />}
    <strong>{skin.name}</strong>
    <span>{skin.description}</span>
  </button>;
}

export function SkinPicker({ choice, onChange }: Props) {
  const [previewing, setPreviewing] = useState(false);
  const restore = () => {
    if (!previewing) return;
    applySkinChoice(choice, false);
    setPreviewing(false);
  };
  const preview = (id: string) => {
    applySkin(id, false);
    setPreviewing(true);
  };
  const select = (next: SkinChoice) => {
    applySkinChoice(next);
    setPreviewing(false);
    onChange(next);
  };
  const resolvedSystem = skins.find((skin) => skin.id === resolveSkinId("system")) || skins[0];

  return <div className="skin-picker">
    <div className="skin-picker-intro"><p>选择工作台的颜色、层次与字号节奏；选择后立即生效并保存在本机。</p></div>
    <div className="skin-grid" role="list" aria-label="皮肤列表">
      <button type="button" className={`skin-card skin-system ${choice === "system" ? "is-selected" : ""}`} aria-pressed={choice === "system"} onClick={() => select("system")} onMouseEnter={() => preview(resolveSkinId("system"))} onFocus={() => preview(resolveSkinId("system"))} onMouseLeave={restore} onBlur={restore}>
        <Swatches colors={resolvedSystem.preview} />
        <strong>跟随系统</strong>
        <span>自动使用系统的浅色或深色偏好</span>
      </button>
      {skins.map((skin) => <SkinCard key={skin.id} skin={skin} selected={choice === skin.id} onSelect={() => select(skin.id)} onPreview={() => preview(skin.id)} onRestore={restore} />)}
    </div>
  </div>;
}
