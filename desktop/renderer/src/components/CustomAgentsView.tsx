import React, { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import "./CapabilitiesView.css";
import "./CustomAgentsView.css";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type ShellMode = "none" | "readonly" | "write";
type Limits = { maxConcurrentTasks: number; maxTurns: number; maxRuntimeSeconds: number };
export type CustomRole = {
  key: string;
  displayName: string;
  enabled: boolean;
  requirement?: string;
  triggers: string[];
  duty: string;
  goal: string;
  rules: string[];
  workflow?: string;
  tools: string[];
  thinking: string;
  writePaths: string[];
  denyPaths?: string[];
  shellMode: ShellMode;
  networkAccess: boolean;
  networkDomains: string[];
  limits: Limits;
  status?: "active" | "pending" | "invalid";
  errors?: string[];
  [extra: string]: unknown;
};
type Listing = { agents: CustomRole[]; tools: Array<{ name: string; label: string }>; reserved: string[]; restartNeeded: boolean };
type Draft = { requirement: string; triggers: string; displayName: string };
type Editing = { role: CustomRole; originalKey: string; rationale: string };

type Props = { connected: boolean; request: Request; onNotice: (text: string) => void };

const STATUS_LABEL = { active: "已生效", pending: "待重启生效", invalid: "配置无效" } as const;
const SHELL_LABEL: Record<ShellMode, string> = { none: "无 Shell", readonly: "只读命令与测试", write: "可写命令（受可写目录限制）" };
const THINKING = [["off", "关闭"], ["minimal", "极少"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"]];
const lines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const emptyDraft: Draft = { requirement: "", triggers: "", displayName: "" };

// 手动创建时的起点：最小只读权限，用户自行补全。
function blankRole(draft: Draft): CustomRole {
  return {
    key: "", displayName: draft.displayName || "", enabled: true, requirement: draft.requirement, triggers: lines(draft.triggers),
    duty: "", goal: "", rules: [], workflow: "", tools: ["read", "grep", "find", "ls"], thinking: "off",
    writePaths: [], shellMode: "none", networkAccess: false, networkDomains: [],
    limits: { maxConcurrentTasks: 1, maxTurns: 8, maxRuntimeSeconds: 900 },
  };
}

// 自定义 Agent：描述需求与触发条件，由 AI 设计身份提示词和工具白名单，用户可逐项修改后保存。
export function CustomAgentsView({ connected, request, onNotice }: Props) {
  const [listing, setListing] = useState<Listing>({ agents: [], tools: [], reserved: [], restartNeeded: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState("");
  const [removeTarget, setRemoveTarget] = useState<CustomRole | null>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    try { setListing(await request<Listing>("custom_agents_list")); }
    catch (error) { onNotice(`读取自定义 Agent 失败：${(error as Error).message}`); }
  }, [connected, request, onNotice]);
  useEffect(() => { void load(); }, [load]);

  async function design(base: Draft, current: CustomRole | null = null, originalKey = "") {
    if (!base.requirement.trim()) { onNotice("请先描述这个 Agent 要解决的需求"); return; }
    setBusy("design");
    try {
      const result = await request<{ role: CustomRole; rationale: string }>("custom_agents_design", {
        requirement: base.requirement, triggers: lines(base.triggers), displayName: base.displayName, current, originalKey,
      });
      setEditing({ role: { ...result.role, enabled: current?.enabled ?? true }, originalKey, rationale: result.rationale });
      setDraft(null);
    } catch (error) { onNotice(`AI 设计失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function save() {
    if (!editing) return;
    setBusy("save");
    try {
      const { role } = await request<{ role: CustomRole }>("custom_agents_save", { role: editing.role, originalKey: editing.originalKey });
      onNotice(`已保存「${role.displayName}」，重启服务后生效`);
      setEditing(null);
      await load();
    } catch (error) { onNotice(`保存失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    try { await request("custom_agents_remove", { key: target.key }); await load(); }
    catch (error) { onNotice(`删除失败：${(error as Error).message}`); }
  }

  async function restart() {
    if (!window.desktop?.restartGateway) { onNotice("当前环境不支持重启服务，请手动重启网关"); return; }
    setBusy("restart");
    try { await window.desktop.restartGateway(); }
    catch (error) { onNotice(`重启失败：${(error as Error).message}`); setBusy(""); }
  }

  const patch = (change: Partial<CustomRole>) => setEditing((current) => current && { ...current, role: { ...current.role, ...change } });
  const patchLimits = (change: Partial<Limits>) => editing && patch({ limits: { ...editing.role.limits, ...change } });
  const toggleTool = (tool: string) => {
    if (!editing) return;
    const tools = editing.role.tools.includes(tool) ? editing.role.tools.filter((item) => item !== tool) : [...editing.role.tools, tool];
    const hasShell = tools.includes("bash") || tools.includes("powershell");
    const shellMode = !hasShell ? "none" : editing.role.shellMode === "none" ? "readonly" : editing.role.shellMode;
    const canWrite = tools.includes("write") || tools.includes("edit");
    patch({ tools, shellMode, writePaths: canWrite && !editing.role.writePaths.length ? ["workspace/{project}/artifacts"] : editing.role.writePaths });
  };

  function renderEditor({ role, originalKey, rationale }: Editing) {
    const hasShell = role.tools.includes("bash") || role.tools.includes("powershell");
    const canWrite = role.tools.includes("write") || role.tools.includes("edit");
    const redesign = () => void design({ requirement: role.requirement || "", triggers: role.triggers.join("\n"), displayName: role.displayName }, role, originalKey);
    return <section className="capability-form custom-agent-editor" aria-label="编辑自定义 Agent">
      <h3 className="custom-agent-section">{originalKey ? `编辑「${role.displayName || originalKey}」` : "确认 AI 设计的 Agent"}</h3>
      {rationale && <p className="capability-intro custom-agent-wide">AI 说明：{rationale}</p>}
      <label>显示名<input value={role.displayName} onChange={(event) => patch({ displayName: event.target.value })} /></label>
      <label>标识（key）<input value={role.key} placeholder="小写字母、数字、下划线" onChange={(event) => patch({ key: event.target.value.trim() })} /></label>
      <label className="custom-agent-wide">需求描述<textarea rows={2} value={role.requirement || ""} onChange={(event) => patch({ requirement: event.target.value })} /></label>
      <label className="custom-agent-wide">触发条件（每行一条，项目经理据此决定何时派发）<textarea rows={3} value={role.triggers.join("\n")} onChange={(event) => patch({ triggers: event.target.value.split(/\r?\n/) })} /></label>

      <h3 className="custom-agent-section">身份提示词</h3>
      <label className="custom-agent-wide">职责<input value={role.duty} onChange={(event) => patch({ duty: event.target.value })} /></label>
      <label className="custom-agent-wide">目标<input value={role.goal} onChange={(event) => patch({ goal: event.target.value })} /></label>
      <label className="custom-agent-wide">行为规则（每行一条）<textarea rows={4} value={role.rules.join("\n")} onChange={(event) => patch({ rules: event.target.value.split(/\r?\n/) })} /></label>
      <label className="custom-agent-wide">工作流程<textarea rows={3} value={role.workflow || ""} onChange={(event) => patch({ workflow: event.target.value })} /></label>

      <h3 className="custom-agent-section">工具白名单与权限</h3>
      <fieldset className="capability-roles custom-agent-wide custom-agent-tools"><legend>可用工具</legend>
        {listing.tools.map((tool) => <label key={tool.name} title={tool.label}><input type="checkbox" checked={role.tools.includes(tool.name)} onChange={() => toggleTool(tool.name)} /><code>{tool.name}</code><span>{tool.label}</span></label>)}
      </fieldset>
      <label>Shell 模式<select value={role.shellMode} disabled={!hasShell} onChange={(event) => patch({ shellMode: event.target.value as ShellMode })}>
        {(hasShell ? ["readonly", "write"] as ShellMode[] : ["none"] as ShellMode[]).map((mode) => <option key={mode} value={mode}>{SHELL_LABEL[mode]}</option>)}
      </select></label>
      <label>思考强度<select value={role.thinking} onChange={(event) => patch({ thinking: event.target.value })}>{THINKING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {canWrite && <label className="custom-agent-wide">可写目录（每行一个，仓库内相对路径，可用 {"{project}"}）<textarea rows={2} value={role.writePaths.join("\n")} onChange={(event) => patch({ writePaths: event.target.value.split(/\r?\n/) })} /></label>}
      <label className="capability-switch"><input type="checkbox" checked={role.networkAccess} onChange={(event) => patch({ networkAccess: event.target.checked })} />允许联网</label>
      {role.networkAccess && <label>允许的域名（每行一个）<textarea rows={2} value={role.networkDomains.join("\n")} onChange={(event) => patch({ networkDomains: event.target.value.split(/\r?\n/) })} /></label>}
      <label>最多轮次<input type="number" min={1} max={40} value={role.limits.maxTurns} onChange={(event) => patchLimits({ maxTurns: Number(event.target.value) })} /></label>
      <label>单次超时（秒）<input type="number" min={1} max={3600} value={role.limits.maxRuntimeSeconds} onChange={(event) => patchLimits({ maxRuntimeSeconds: Number(event.target.value) })} /></label>
      <label className="capability-switch"><input type="checkbox" checked={role.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用</label>

      <div className="capability-form-actions">
        <button className="quiet-button" onClick={() => setEditing(null)}>取消</button>
        <button className="quiet-button" disabled={busy !== "" || !(role.requirement || "").trim()} onClick={redesign}>{busy === "design" ? "设计中…" : "让 AI 重新设计"}</button>
        <button className="capability-primary" disabled={busy !== ""} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存"}</button>
      </div>
    </section>;
  }

  function renderDraft(value: Draft) {
    return <section className="capability-form" aria-label="新建自定义 Agent">
      <label>显示名（可选）<input value={value.displayName} placeholder="留空由 AI 起名，例如 数据分析师" onChange={(event) => setDraft({ ...value, displayName: event.target.value })} /></label>
      <span />
      <label className="custom-agent-wide">需求<textarea rows={4} value={value.requirement} placeholder="这个 Agent 要解决什么问题、交付什么，例如：根据接口日志分析性能瓶颈并给出优化建议报告" onChange={(event) => setDraft({ ...value, requirement: event.target.value })} /></label>
      <label className="custom-agent-wide">触发条件（每行一条，可留空由 AI 推断）<textarea rows={3} value={value.triggers} placeholder={"用户提到性能慢、超时或需要压测时\n交付前需要性能评估时"} onChange={(event) => setDraft({ ...value, triggers: event.target.value })} /></label>
      <div className="capability-form-actions">
        <button className="quiet-button" onClick={() => setDraft(null)}>取消</button>
        <button className="quiet-button" disabled={busy !== ""} onClick={() => { setEditing({ role: blankRole(value), originalKey: "", rationale: "" }); setDraft(null); }}>手动填写</button>
        <button className="capability-primary" disabled={busy !== "" || !value.requirement.trim()} onClick={() => void design(value)}>{busy === "design" ? "AI 设计中…" : "AI 设计"}</button>
      </div>
    </section>;
  }

  return (
    <div className="central-view settings-content capabilities-view">
      <p className="capability-intro">描述需求和触发条件，AI 会设计这个 Agent 的身份提示词、工具白名单和权限范围，你可以逐项修改。保存后由项目经理在满足触发条件时派发；新增或修改需重启服务后生效。</p>
      {listing.restartNeeded && <div className="setup-hint custom-agent-restart"><span>有自定义 Agent 的改动尚未生效。</span><button disabled={busy === "restart"} onClick={() => void restart()}>{busy === "restart" ? "重启中…" : "重启服务使其生效"}</button></div>}
      {!draft && !editing && <button className="capability-add" disabled={!connected} onClick={() => setDraft(emptyDraft)}>＋ 新建 Agent</button>}
      {draft && renderDraft(draft)}
      {editing && renderEditor(editing)}
      {listing.agents.length === 0 && !draft && !editing && <p className="capability-empty">还没有自定义 Agent。</p>}
      {listing.agents.map((role) => <article key={role.key} className={`capability-card ${role.enabled === false || role.status === "invalid" ? "is-disabled" : ""}`}>
        <div className="capability-card-heading">
          <strong>{role.displayName} <code className="custom-agent-key">{role.key}</code></strong>
          {role.status && <span className={`capability-badge custom-agent-status-${role.status}`}>{STATUS_LABEL[role.status]}</span>}
          {role.enabled === false && <span className="capability-badge">已停用</span>}
          <button className="quiet-button" disabled={!connected || role.status === "invalid" || Boolean(editing)} onClick={() => { setDraft(null); setEditing({ role, originalKey: role.key, rationale: "" }); }}>编辑</button>
          <button className="quiet-button" disabled={!connected} onClick={() => setRemoveTarget(role)}>删除</button>
        </div>
        {role.errors?.length ? <p className="capability-warning">{role.errors.join("；")}</p> : null}
        {role.duty && <p>{role.duty}</p>}
        {role.triggers?.length ? <ul className="custom-agent-triggers">{role.triggers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {role.tools?.length ? <div className="capability-tools">工具：{role.tools.map((tool) => <code key={tool}>{tool}</code>)}<span>· {SHELL_LABEL[role.shellMode] || role.shellMode}{role.networkAccess ? " · 可联网" : ""}</span></div> : null}
      </article>)}
      {removeTarget && <ConfirmDialog
        title="删除自定义 Agent？"
        description={<>将删除 <strong>{removeTarget.displayName}</strong>（{removeTarget.key}）的配置，重启服务后不再派发。此操作无法撤销。</>}
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />}
    </div>
  );
}
