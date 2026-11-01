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

  const waiting = tasks.filter((task) => ["awaiting_approval", "awaiting_choice"].includes(snapshotStatus(task)));
  const agentName = (key: string) => agents.find((agent) => agent.key === key)?.displayName || key;

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>Agent 工具与角色边界</span><h2>权限管理</h2><p>集中查看各角色的基础工具开关、自定义 Agent 的工具白名单与文件/网络边界。本页只读，修改入口在技能中心和自定义 Agent。</p></div>
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
        <div>{role.capabilities.map((item) => <span key={item.name} className={`permission-token ${item.enabled ? "is-on" : ""}`} title={item.description}>{item.label || item.name}</span>)}</div>
      </article>)}</div>
    </section>

    <section className="permission-section">
      <header><h3>自定义 Agent 边界</h3><span>{custom.length} 个</span></header>
      {!custom.length && <div className="feature-empty compact"><strong>没有自定义 Agent</strong><span>可在“自定义 Agent”页面创建，并为它设置工具、目录和网络边界。</span></div>}
      <div className="permission-policy-list">{custom.map((role) => <article className="permission-policy-card" key={role.key}>
        <header><div><strong>{role.displayName || role.key}</strong><code>{role.key}</code></div><span>{role.enabled === false ? "已停用" : "已启用"}</span></header>
        <dl>
          <div><dt>Shell</dt><dd>{SHELL_LABEL[role.shellMode || "none"] || role.shellMode}</dd></div>
          <div><dt>网络</dt><dd>{role.networkAccess ? (role.networkDomains?.length ? role.networkDomains.join("、") : "允许") : "禁止"}</dd></div>
          <div><dt>轮次/超时</dt><dd>{role.limits?.maxTurns || "—"} / {role.limits?.maxRuntimeSeconds || "—"}s</dd></div>
          <div><dt>并发</dt><dd>{role.limits?.maxConcurrentTasks || "—"}</dd></div>
        </dl>
        <div className="permission-policy-tags">{(role.tools || []).map((tool) => <code key={tool}>{tool}</code>)}</div>
        <p>可写：{role.writePaths?.length ? role.writePaths.join("、") : "无"}；拒绝：{role.denyPaths?.length ? role.denyPaths.join("、") : "未配置"}</p>
      </article>)}</div>
    </section>
    <p className="feature-note">数据来源：`capabilities_list`（基础工具开关）与 `custom_agents_list`（角色工具/目录/网络策略）；审批动作仍在任务对话中的确认卡完成。</p>
  </div>;
}
