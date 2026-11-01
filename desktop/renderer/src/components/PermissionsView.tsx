import { useCallback, useEffect, useState } from "react";
import type { Agent, Task } from "../types";
import { snapshotStatus } from "../format";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type BaseCapability = { name: string; label: string; description: string; enabled: boolean };
type BaseAgent = { agentKey: string; capabilities: BaseCapability[] };
type CustomRole = {
  key: string;
  displayName: string;
  enabled?: boolean;
  tools?: string[];
  writePaths?: string[];
  denyPaths?: string[];
  shellMode?: "none" | "readonly" | "write";
  networkAccess?: boolean;
  networkDomains?: string[];
  limits?: { maxConcurrentTasks?: number; maxTurns?: number; maxRuntimeSeconds?: number };
};

type Props = {
  agents: Agent[];
  tasks: Task[];
  connected: boolean;
  request: Request;
  onNotice: (text: string) => void;
  onOpenTask: (taskId: string) => void;
};

const SHELL_LABEL = { none: "无 Shell", readonly: "只读命令与测试", write: "可写命令" } as const;

export function PermissionsView({ agents, tasks, connected, request, onNotice, onOpenTask }: Props) {
  const [base, setBase] = useState<BaseAgent[]>([]);
  const [custom, setCustom] = useState<CustomRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<CustomRole | null>(null);

  const load = useCallback(async () => {
    if (!connected) {
      setBase([]);
      setCustom([]);
      return;
    }
    setLoading(true);
    try {
      const [capabilities, customAgents] = await Promise.all([
        request<{ base?: BaseAgent[] }>("capabilities_list"),
        request<{ agents: CustomRole[] }>("custom_agents_list"),
      ]);
      setBase(capabilities.base || []);
      setCustom(customAgents.agents || []);
    } catch (error) {
      onNotice(`读取权限配置失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [connected, onNotice, request]);

  useEffect(() => { void load(); }, [load]);
  async function updateBase(agentKey: string, tool: string, enabled: boolean) {
    setBusy(`${agentKey}:${tool}`);
    try { await request("capabilities_base_assign", { agentKey, tool, enabled }); await load(); }
    catch (error) { onNotice(`修改基础权限失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }
  async function toggleRole(role: CustomRole) {
    try { await request("custom_agents_save", { role: { ...role, enabled: role.enabled === false }, originalKey: role.key }); await load(); }
    catch (error) { onNotice(`修改角色权限失败：${(error as Error).message}`); }
  }
  async function saveRole() {
    if (!editing) return;
    setBusy(`role:${editing.key}`);
    try {
      await request("custom_agents_save", { role: editing, originalKey: editing.key });
      setEditing(null);
      await load();
    } catch (error) { onNotice(`保存角色边界失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }
  const splitLines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

  const waiting = tasks.filter((task) => ["awaiting_approval", "awaiting_choice"].includes(snapshotStatus(task)));
  const agentName = (key: string) => agents.find((agent) => agent.key === key)?.displayName || key;

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>Agent 工具与角色边界</span><h2>权限管理</h2><p>直接修改已有角色的基础工具开关和启用状态；目录、Shell、网络和工具白名单沿用自定义 Agent 编辑器的校验规则。</p></div>
      <dl><div><dt>角色</dt><dd>{base.length || agents.length}</dd></div><div><dt>等待确认</dt><dd>{waiting.length}</dd></div></dl>
    </section>
    <div className="feature-toolbar"><span className="feature-toolbar-note">权限变更仍通过现有 `capabilities_*` 与 `custom_agents_*` 命令执行。</span><button className="quiet-button" onClick={() => void load()} disabled={loading || !connected}>{loading ? "读取中…" : "刷新"}</button></div>

    {waiting.length > 0 && <section className="permission-section">
      <header><h3>等待确认的任务</h3><span>{waiting.length} 项</span></header>
      <div className="permission-waiting-list">{waiting.map((task) => <button key={task.task_id} onClick={() => onOpenTask(task.task_id || "")}>
        <strong>{task.title || task.task_id}</strong>
        <span>{task.project_name || "未归属项目"} · {task.agent || "未指定 Agent"}</span>
        <small>打开任务处理确认</small>
      </button>)}</div>
    </section>}

    <section className="permission-section">
      <header><h3>基础工具权限</h3><span>来自能力注册表</span></header>
      {!base.length && <div className="feature-empty compact"><strong>暂无可读取的基础权限</strong><span>连接网关后显示各角色默认工具开关。</span></div>}
      <div className="permission-agent-grid">{base.map((role) => <article className="permission-agent-card" key={role.agentKey}>
        <header><strong>{agentName(role.agentKey)}</strong><span>{role.capabilities.filter((item) => item.enabled).length}/{role.capabilities.length} 启用</span></header>
            <div>{role.capabilities.map((item) => <label key={item.name} className={`permission-token ${item.enabled ? "is-on" : ""}`} title={item.description}><input type="checkbox" checked={item.enabled} disabled={busy === `${role.agentKey}:${item.name}`} onChange={(event) => void updateBase(role.agentKey, item.name, event.target.checked)} />{item.label || item.name}</label>)}</div>
      </article>)}</div>
    </section>

    <section className="permission-section">
      <header><h3>自定义 Agent 边界</h3><span>{custom.length} 个</span></header>
      {!custom.length && <div className="feature-empty compact"><strong>没有自定义 Agent</strong><span>可在“自定义 Agent”页面创建，并为它设置工具、目录和网络边界。</span></div>}
      <div className="permission-policy-list">{custom.map((role) => <article className="permission-policy-card" key={role.key}>
        <header><div><strong>{role.displayName || role.key}</strong><code>{role.key}</code></div><label><input type="checkbox" checked={role.enabled !== false} onChange={() => void toggleRole(role)} />{role.enabled === false ? "已停用" : "已启用"}</label></header>
        <dl>
          <div><dt>Shell</dt><dd>{SHELL_LABEL[role.shellMode || "none"] || role.shellMode}</dd></div>
          <div><dt>网络</dt><dd>{role.networkAccess ? (role.networkDomains?.length ? role.networkDomains.join("、") : "允许") : "禁止"}</dd></div>
          <div><dt>轮次/超时</dt><dd>{role.limits?.maxTurns || "—"} / {role.limits?.maxRuntimeSeconds || "—"}s</dd></div>
          <div><dt>并发</dt><dd>{role.limits?.maxConcurrentTasks || "—"}</dd></div>
        </dl>
        <div className="permission-policy-tags">{(role.tools || []).map((tool) => <code key={tool}>{tool}</code>)}</div>
        <p>可写：{role.writePaths?.length ? role.writePaths.join("、") : "无"}；拒绝：{role.denyPaths?.length ? role.denyPaths.join("、") : "未配置"}</p>
        <button className="quiet-button" onClick={() => setEditing({ ...role, tools: [...(role.tools || [])], writePaths: [...(role.writePaths || [])], denyPaths: [...(role.denyPaths || [])], networkDomains: [...(role.networkDomains || [])] })}>编辑边界</button>
      </article>)}</div>
    </section>
    {editing && <section className="permission-section capability-form" aria-label="编辑角色边界">
      <header><h3>编辑「{editing.displayName || editing.key}」</h3><span>{editing.key}</span></header>
      <label>工具白名单（每行一个）<textarea rows={4} value={(editing.tools || []).join("\n")} onChange={(event) => setEditing({ ...editing, tools: splitLines(event.target.value) })} /></label>
      <label>可写目录（每行一个）<textarea rows={3} value={(editing.writePaths || []).join("\n")} onChange={(event) => setEditing({ ...editing, writePaths: splitLines(event.target.value) })} /></label>
      <label>拒绝目录（每行一个）<textarea rows={3} value={(editing.denyPaths || []).join("\n")} onChange={(event) => setEditing({ ...editing, denyPaths: splitLines(event.target.value) })} /></label>
      <label>Shell 模式<select value={editing.shellMode || "none"} onChange={(event) => setEditing({ ...editing, shellMode: event.target.value as CustomRole["shellMode"] })}><option value="none">无 Shell</option><option value="readonly">只读命令与测试</option><option value="write">可写命令</option></select></label>
      <label><input type="checkbox" checked={editing.networkAccess === true} onChange={(event) => setEditing({ ...editing, networkAccess: event.target.checked })} />允许联网</label>
      <label>允许域名（每行一个）<textarea rows={2} value={(editing.networkDomains || []).join("\n")} onChange={(event) => setEditing({ ...editing, networkDomains: splitLines(event.target.value) })} /></label>
      <div className="capability-form-actions"><button className="quiet-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" disabled={busy === `role:${editing.key}`} onClick={() => void saveRole()}>{busy === `role:${editing.key}` ? "保存中…" : "保存边界"}</button></div>
    </section>}
    <p className="feature-note">数据来源：`capabilities_list`（基础工具开关）与 `custom_agents_list`（角色工具/目录/网络策略）；审批动作仍在任务对话中的确认卡完成。</p>
  </div>;
}
