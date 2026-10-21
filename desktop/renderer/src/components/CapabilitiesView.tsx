import React, { useCallback, useEffect, useState } from "react";
import type { Agent } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import "./CapabilitiesView.css";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type Kind = "base" | "skill" | "plugin";
type Capability = {
  kind: Exclude<Kind, "base">;
  name: string;
  description: string;
  roles: string[];
  enabled: boolean;
  source: string;
  installedAt: string;
  installed: boolean;
  tools?: string[];
  local?: boolean;
  path?: string;
};
type BaseCapability = { name: string; label: string; description: string; enabled: boolean };
type BaseAgent = { agentKey: string; capabilities: BaseCapability[] };
type Listing = {
  skills: Capability[];
  plugins: Capability[];
  base?: BaseAgent[];
  local?: { skills: Capability[]; plugins: Capability[]; error?: string };
};
type SourceType = "github" | "local" | "inline";

type Props = {
  agents: Agent[];
  connected: boolean;
  request: Request;
  onNotice: (text: string) => void;
};

const KIND_LABEL: Record<Kind, string> = { base: "基础能力", skill: "Skill", plugin: "插件" };
const keyOf = (item: Capability) => `${item.kind}:${item.local ? item.path : item.name}`;

// 机器人能力：给各个角色添加 Skill（知识与操作指引）或插件（新工具），按角色启用，改完下一次执行即生效。
export function CapabilitiesView({ agents, connected, request, onNotice }: Props) {
  const [kind, setKind] = useState<Kind>("skill");
  const [items, setItems] = useState<Listing>({ skills: [], plugins: [] });
  const [adding, setAdding] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [spec, setSpec] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [inline, setInline] = useState({ name: "", description: "", body: "" });
  const [roles, setRoles] = useState<string[]>([]);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState("");
  const [removeTarget, setRemoveTarget] = useState<Capability | null>(null);
  const roleAgents = agents.filter((agent) => agent.enabled !== false);

  const load = useCallback(async () => {
    if (!connected) return;
    try { setItems(await request<Listing>("capabilities_list")); }
    catch (error) { onNotice(`读取能力失败：${(error as Error).message}`); }
  }, [connected, request, onNotice]);
  useEffect(() => { void load(); }, [load]);

  function resetForm() {
    setAdding(false); setSpec(""); setLocalPath(""); setInline({ name: "", description: "", body: "" }); setRoles([]); setTrust(false);
  }

  async function pickFolder() {
    const path = await window.desktop?.selectDirectory?.();
    if (path) setLocalPath(path);
  }

  async function install() {
    if (!connected) { onNotice("本地任务服务未连接，暂时不能添加能力"); return; }
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
    if (!connected) { onNotice("本地任务服务未连接，暂时不能修改能力"); return; }
    setBusy(keyOf(item));
    try {
      await request("capabilities_assign", item.local ? { kind: item.kind, local: true, path: item.path, ...patch } : { kind: item.kind, name: item.name, ...patch });
      await load();
    } catch (error) { onNotice(`更新失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function updateBase(agentKey: string, tool: string, enabled: boolean) {
    if (!connected) { onNotice("本地任务服务未连接，暂时不能修改基础能力"); return; }
    const key = `base:${agentKey}:${tool}`;
    setBusy(key);
    try {
      await request("capabilities_base_assign", { agentKey, tool, enabled });
      await load();
    } catch (error) { onNotice(`更新基础能力失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  function remove(item: Capability) {
    if (!connected) { onNotice("本地任务服务未连接，暂时不能移除能力"); return; }
    setRemoveTarget(item);
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const item = removeTarget;
    setRemoveTarget(null);
    try {
      setBusy(`${item.kind}:${item.name}`);
      await request("capabilities_remove", { kind: item.kind, name: item.name });
      await load();
    } catch (error) { onNotice(`移除失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  const toggle = (list: string[], key: string) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
  const list = kind === "skill" ? items.skills : kind === "plugin" ? items.plugins : [];
  const localList = (kind === "skill" ? items.local?.skills : kind === "plugin" ? items.local?.plugins : []) || [];
  const countOf = (item: Kind) => item === "base"
    ? (items.base || []).reduce((sum, role) => sum + role.capabilities.length, 0)
    : item === "skill" ? items.skills.length + (items.local?.skills.length || 0) : items.plugins.length + (items.local?.plugins.length || 0);
  const canInstall = sourceType === "github" ? Boolean(spec.trim())
    : sourceType === "local" ? Boolean(localPath)
      : Boolean(inline.name && inline.description && inline.body);

  function renderCard(item: Capability) {
    const key = keyOf(item);
    return <article key={key} className={`capability-card ${item.enabled && (!item.local || item.roles.length) ? "" : "is-disabled"}`}>
      <div className="capability-card-heading">
        <strong>{item.name}</strong>
        {item.local && <span className="capability-badge">本机</span>}
        {!item.installed && <span className="capability-warning">文件缺失</span>}
        <label className="capability-switch"><input type="checkbox" checked={item.enabled} disabled={busy === key} onChange={(event) => void update(item, { enabled: event.target.checked })} />启用</label>
        {!item.local && <button className="quiet-button" onClick={() => void remove(item)}>移除</button>}
      </div>
      {item.description && <p className={item.local ? "capability-clamp" : ""}>{item.description}</p>}
      {item.tools?.length ? <div className="capability-tools">工具：{item.tools.map((tool) => <code key={tool}>{tool}</code>)}</div> : null}
      <div className="capability-roles inline">
        {roleAgents.map((agent) => <label key={agent.key}><input type="checkbox" checked={item.roles.includes(agent.key)} disabled={busy === key} onChange={() => void update(item, { roles: toggle(item.roles, agent.key) })} />{agent.displayName || agent.key}</label>)}
      </div>
      <small>{item.local ? item.source : `来源：${item.source}`}</small>
    </article>;
  }

  function renderBaseRole(role: BaseAgent) {
    const agent = roleAgents.find((item) => item.key === role.agentKey);
    const enabled = role.capabilities.filter((item) => item.enabled).length;
    return <article className="base-capability-card" key={role.agentKey}>
      <header><div><strong>{agent?.displayName || role.agentKey}</strong><small>{role.agentKey}</small></div><span>{enabled}/{role.capabilities.length} 项启用</span></header>
      <p>以下是该机器人默认具备的基础工具，全部默认启用；取消勾选后从下一次执行开始不再提供。</p>
      <div className="base-capability-grid">
        {role.capabilities.map((item) => {
          const key = `base:${role.agentKey}:${item.name}`;
          return <label key={item.name} className={`base-capability-item ${item.enabled ? "is-enabled" : ""}`}>
            <input type="checkbox" checked={item.enabled} disabled={busy === key || !connected} onChange={(event) => void updateBase(role.agentKey, item.name, event.target.checked)} />
            <span><strong>{item.label}</strong><code>{item.name}</code><small>{item.description}</small></span>
          </label>;
        })}
      </div>
    </article>;
  }

  return (
    <div className="central-view settings-content capabilities-view">
      <div className="capability-tabs" role="tablist">
        {(["base", "skill", "plugin"] as Kind[]).map((item) => <button key={item} role="tab" aria-selected={kind === item} className={kind === item ? "is-selected" : ""} onClick={() => { setKind(item); resetForm(); if (item === "plugin" && sourceType === "inline") setSourceType("github"); }}>
          {KIND_LABEL[item]}<span>{countOf(item)}</span>
        </button>)}
      </div>
      <p className="capability-intro">{kind === "base"
        ? "展示六个机器人当前具备的基础工具。基础能力默认全部启用，也可以取消勾选；变更会在下一次 Agent 执行时生效。"
        : kind === "skill"
        ? "Skill 是一份操作指引（含 SKILL.md 的文件夹）。分配给角色后，机器人会在需要时自行读取。"
        : "插件为机器人提供新工具（plugin.json + 入口脚本）。插件代码在本机网关中运行，只安装你信任的插件；工具调用仍受策略闸门约束。"}</p>

      {kind === "base" && <section className="base-capability-section">
        {(items.base || []).map(renderBaseRole)}
        {!items.base?.length && <p className="capability-empty">还没有读取到基础能力。</p>}
      </section>}

      {kind !== "base" && !adding && <button className="capability-add" disabled={!connected} onClick={() => setAdding(true)}>＋ 添加{KIND_LABEL[kind]}</button>}
      {kind !== "base" && adding && <section className="capability-form">
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

      {kind !== "base" && list.length === 0 && !adding && <p className="capability-empty">能力库里还没有{KIND_LABEL[kind]}。</p>}
      {list.map(renderCard)}
      {kind !== "base" && (localList.length > 0 || items.local?.error) && <section className="capability-local-section">
        <h3>本机已安装</h3>
        <p className="capability-intro">来自本机 Pi 环境（~/.pi/agent、~/.agents/skills、已安装的 Pi 包等），不会复制。默认不分配给任何机器人，勾选角色后该角色才会加载。</p>
        {items.local?.error && <p className="capability-warning">读取本机能力失败：{items.local.error}</p>}
        {localList.map(renderCard)}
      </section>}
      {removeTarget && <ConfirmDialog
        title={`移除${KIND_LABEL[removeTarget.kind]}？`}
        description={<>将从本机删除 <strong>{removeTarget.name}</strong> 及其文件。此操作无法撤销。</>}
        confirmLabel="确认移除"
        tone="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />}
    </div>
  );
}
