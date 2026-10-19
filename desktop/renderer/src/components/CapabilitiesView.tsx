import React, { useCallback, useEffect, useState } from "react";
import type { Agent } from "../types";
import "./CapabilitiesView.css";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type Kind = "skill" | "plugin";
type Capability = {
  kind: Kind;
  name: string;
  description: string;
  roles: string[];
  enabled: boolean;
  source: string;
  installedAt: string;
  installed: boolean;
  tools?: string[];
};
type SourceType = "github" | "local" | "inline";

type Props = {
  agents: Agent[];
  request: Request;
  onNotice: (text: string) => void;
};

const KIND_LABEL: Record<Kind, string> = { skill: "Skill", plugin: "插件" };

// 机器人能力：给各个角色添加 Skill（知识与操作指引）或插件（新工具），按角色启用，改完下一次执行即生效。
export function CapabilitiesView({ agents, request, onNotice }: Props) {
  const [kind, setKind] = useState<Kind>("skill");
  const [items, setItems] = useState<{ skills: Capability[]; plugins: Capability[] }>({ skills: [], plugins: [] });
  const [adding, setAdding] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [spec, setSpec] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [inline, setInline] = useState({ name: "", description: "", body: "" });
  const [roles, setRoles] = useState<string[]>([]);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState("");
  const roleAgents = agents.filter((agent) => agent.enabled !== false);

  const load = useCallback(async () => {
    try { setItems(await request<{ skills: Capability[]; plugins: Capability[] }>("capabilities_list")); }
    catch (error) { onNotice(`读取能力失败：${(error as Error).message}`); }
  }, [request, onNotice]);
  useEffect(() => { void load(); }, [load]);

  function resetForm() {
    setAdding(false); setSpec(""); setLocalPath(""); setInline({ name: "", description: "", body: "" }); setRoles([]); setTrust(false);
  }

  async function pickFolder() {
    const path = await window.desktop?.selectDirectory?.();
    if (path) setLocalPath(path);
  }

  async function install() {
    const source = sourceType === "github" ? { type: "github", spec } : sourceType === "local" ? { type: "local", path: localPath } : { type: "inline", ...inline };
    setBusy("install");
    try {
      const { capability } = await request<{ capability: Capability }>("capabilities_install", { kind, source, roles, trustPlugin: trust });
      onNotice(`已添加${KIND_LABEL[kind]}：${capability.name}`);
      resetForm();
      await load();
    } catch (error) { onNotice(`添加失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function update(item: Capability, patch: { roles?: string[]; enabled?: boolean }) {
    setBusy(`${item.kind}:${item.name}`);
    try {
      await request("capabilities_assign", { kind: item.kind, name: item.name, ...patch });
      await load();
    } catch (error) { onNotice(`更新失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function remove(item: Capability) {
    if (!window.confirm(`移除${KIND_LABEL[item.kind]} ${item.name}？文件会一并删除。`)) return;
    try {
      await request("capabilities_remove", { kind: item.kind, name: item.name });
      await load();
    } catch (error) { onNotice(`移除失败：${(error as Error).message}`); }
  }

  const toggle = (list: string[], key: string) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
  const list = kind === "skill" ? items.skills : items.plugins;
  const canInstall = sourceType === "github" ? Boolean(spec.trim())
    : sourceType === "local" ? Boolean(localPath)
      : Boolean(inline.name && inline.description && inline.body);

  return (
    <div className="central-view settings-content capabilities-view">
      <div className="capability-tabs" role="tablist">
        {(["skill", "plugin"] as Kind[]).map((item) => <button key={item} role="tab" aria-selected={kind === item} className={kind === item ? "is-selected" : ""} onClick={() => { setKind(item); resetForm(); if (item === "plugin" && sourceType === "inline") setSourceType("github"); }}>
          {KIND_LABEL[item]}<span>{(item === "skill" ? items.skills : items.plugins).length}</span>
        </button>)}
      </div>
      <p className="capability-intro">{kind === "skill"
        ? "Skill 是一份操作指引（含 SKILL.md 的文件夹）。分配给角色后，机器人会在需要时自行读取。"
        : "插件为机器人提供新工具（plugin.json + 入口脚本）。插件代码在本机网关中运行，只安装你信任的插件；工具调用仍受策略闸门约束。"}</p>

      {!adding && <button className="capability-add" onClick={() => setAdding(true)}>＋ 添加{KIND_LABEL[kind]}</button>}
      {adding && <section className="capability-form">
        <div className="capability-sources">
          <label><input type="radio" checked={sourceType === "github"} onChange={() => setSourceType("github")} />GitHub</label>
          <label><input type="radio" checked={sourceType === "local"} onChange={() => setSourceType("local")} />本地文件夹</label>
          {kind === "skill" && <label><input type="radio" checked={sourceType === "inline"} onChange={() => setSourceType("inline")} />直接编写</label>}
        </div>
        {sourceType === "github" && <label>仓库与目录<input value={spec} placeholder="owner/repo/skills/xxx@main" onChange={(event) => setSpec(event.target.value)} /></label>}
        {sourceType === "local" && <div className="capability-local"><button className="quiet-button" onClick={() => void pickFolder()}>选择文件夹</button><span>{localPath || "未选择"}</span></div>}
        {sourceType === "inline" && <>
          <label>名称<input value={inline.name} placeholder="小写字母、数字、连字符，例如 sql-style" onChange={(event) => setInline({ ...inline, name: event.target.value })} /></label>
          <label>何时使用（描述）<input value={inline.description} placeholder="机器人靠这句话判断什么时候用它" onChange={(event) => setInline({ ...inline, description: event.target.value })} /></label>
          <label>正文（Markdown）<textarea rows={8} value={inline.body} onChange={(event) => setInline({ ...inline, body: event.target.value })} /></label>
        </>}
        <fieldset className="capability-roles"><legend>分配给</legend>
          {roleAgents.map((agent) => <label key={agent.key}><input type="checkbox" checked={roles.includes(agent.key)} onChange={() => setRoles(toggle(roles, agent.key))} />{agent.displayName || agent.key}</label>)}
        </fieldset>
        {kind === "plugin" && <label className="capability-trust"><input type="checkbox" checked={trust} onChange={(event) => setTrust(event.target.checked)} />我已检查并信任这个插件的代码</label>}
        <div className="capability-form-actions">
          <button className="quiet-button" onClick={resetForm}>取消</button>
          <button className="capability-primary" disabled={!canInstall || busy === "install" || (kind === "plugin" && !trust)} onClick={() => void install()}>{busy === "install" ? "添加中…" : "添加"}</button>
        </div>
      </section>}

      {list.length === 0 && !adding && <p className="capability-empty">还没有{KIND_LABEL[kind]}。</p>}
      {list.map((item) => <article key={item.name} className={`capability-card ${item.enabled ? "" : "is-disabled"}`}>
        <div className="capability-card-heading">
          <strong>{item.name}</strong>
          {!item.installed && <span className="capability-warning">文件缺失</span>}
          <label className="capability-switch"><input type="checkbox" checked={item.enabled} disabled={busy === `${item.kind}:${item.name}`} onChange={(event) => void update(item, { enabled: event.target.checked })} />启用</label>
          <button className="quiet-button" onClick={() => void remove(item)}>移除</button>
        </div>
        <p>{item.description}</p>
        {item.tools?.length ? <div className="capability-tools">工具：{item.tools.map((tool) => <code key={tool}>{tool}</code>)}</div> : null}
        <div className="capability-roles inline">
          {roleAgents.map((agent) => <label key={agent.key}><input type="checkbox" checked={item.roles.includes(agent.key)} disabled={busy === `${item.kind}:${item.name}`} onChange={() => void update(item, { roles: toggle(item.roles, agent.key) })} />{agent.displayName || agent.key}</label>)}
        </div>
        <small>来源：{item.source}</small>
      </article>)}
    </div>
  );
}
