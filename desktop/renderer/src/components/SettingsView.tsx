import React, { useEffect, useMemo, useState } from "react";
import type { SettingsEntry, SettingsField, SettingsGroup, SettingsSnapshot } from "../types";

type Props = {
  onSaved: () => void;
  onNotice: (message: string) => void;
};

type Drafts = Record<string, string>;

const SOURCE_CLASS: Record<string, string> = {
  设置: "source-settings",
  系统环境变量: "source-system",
  桌面端管理: "source-managed",
  默认: "source-default",
  未配置: "source-missing",
};

function matches(field: SettingsField, query: string) {
  if (!query) return true;
  const text = `${field.label} ${field.key} ${field.description || ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => text.includes(part));
}

function SourceBadge({ entry }: { entry?: SettingsEntry }) {
  if (!entry) return null;
  return <span className={`setting-source ${SOURCE_CLASS[entry.source] || ""}`}>{entry.source}</span>;
}

function FieldInput({ field, entry, draft, onChange }: { field: SettingsField; entry?: SettingsEntry; draft: string | undefined; onChange: (value: string | undefined) => void }) {
  const id = `setting-${field.key}`;
  const current = draft ?? entry?.value ?? "";
  if (field.managed) {
    return <input id={id} value={entry?.effective || ""} disabled readOnly aria-readonly="true" />;
  }
  if (field.type === "secret") {
    const status = entry?.configured ? (entry.readable ? "已保存，输入新值覆盖" : "已保存但无法解密，请重新输入") : entry?.fromSystemEnv ? "来自系统环境变量，可在此覆盖" : "未配置";
    return <span className="setting-secret-row">
      <input id={id} type="password" autoComplete="off" value={draft ?? ""} placeholder={draft === "" ? "将清除已保存的值" : status} onChange={(event) => onChange(event.target.value || undefined)} />
      {entry?.configured && draft !== "" && <button type="button" className="quiet-button" onClick={() => onChange("")}>清除</button>}
      {draft === "" && <button type="button" className="quiet-button" onClick={() => onChange(undefined)}>撤销</button>}
    </span>;
  }
  if (field.type === "boolean") {
    const on = (current || entry?.effective || field.default || "") === field.trueValue;
    return <label className="setting-switch">
      <input id={id} type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked ? String(field.trueValue) : String(field.falseValue))} />
      <span>{on ? "开启" : "关闭"}</span>
    </label>;
  }
  if (field.type === "roles") {
    const selected = new Set((current || entry?.effective || field.default || "").split(",").map((item) => item.trim()).filter(Boolean));
    return <span className="setting-roles">{(field.options || []).map(([value, label]) => <label key={value} className={selected.has(value) ? "is-on" : ""}>
      <input type="checkbox" checked={selected.has(value)} onChange={(event) => {
        const next = new Set(selected);
        if (event.target.checked) next.add(value); else next.delete(value);
        onChange((field.options || []).map(([key]) => key).filter((key) => next.has(key)).join(","));
      }} />{label}
    </label>)}</span>;
  }
  if (field.type === "select" && !field.allowCustom) {
    return <select id={id} value={current} onChange={(event) => onChange(event.target.value)}>
      <option value="">{`默认（${field.options?.find(([value]) => value === (entry?.effective || field.default))?.[1] || entry?.effective || field.default || "未设置"}）`}</option>
      {(field.options || []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>;
  }
  const listId = field.type === "select" ? `${id}-options` : undefined;
  return <>
    <input
      id={id}
      type={field.type === "number" ? "number" : "text"}
      min={field.min}
      list={listId}
      value={current}
      placeholder={entry?.effective ? `${entry.effective}（${entry.source}）` : field.placeholder || "未设置"}
      onChange={(event) => onChange(event.target.value)}
    />
    {listId && <datalist id={listId}>{(field.options || []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</datalist>}
  </>;
}

function FieldRow({ field, entry, draft, onChange }: { field: SettingsField; entry?: SettingsEntry; draft: string | undefined; onChange: (value: string | undefined) => void }) {
  const dirty = draft !== undefined;
  const canReset = !field.managed && field.type !== "secret" && Boolean(entry?.value) && draft !== "";
  return <div className={`setting-row ${dirty ? "is-dirty" : ""}`}>
    <div className="setting-meta">
      <label htmlFor={`setting-${field.key}`}>{field.label}</label>
      <code>{field.key}</code>
      {field.description && <p>{field.description}</p>}
    </div>
    <div className="setting-control">
      <FieldInput field={field} entry={entry} draft={draft} onChange={onChange} />
      <span className="setting-control-meta">
        {dirty ? <span className="setting-source source-dirty">未保存</span> : <SourceBadge entry={entry} />}
        {canReset && <button type="button" className="link-button" onClick={() => onChange("")}>恢复默认</button>}
      </span>
    </div>
  </div>;
}

// 关闭飞书后这些分组只保留开关，凭据与看板配置收起（已保存的值不动）。
const FEISHU_GROUPS = new Set(["feishu", "bitable"]);

function GroupSection({ group, snapshot, drafts, query, provider, feishuOff, setDraft }: { group: SettingsGroup; snapshot: SettingsSnapshot; drafts: Drafts; query: string; provider: string; feishuOff: boolean; setDraft: (key: string, value: string | undefined) => void }) {
  const hidden = feishuOff && FEISHU_GROUPS.has(group.id);
  const visible = group.fields.filter((field) => matches(field, query) && (!hidden || field.key === "FEISHU_ENABLED"));
  if (!visible.length) return null;
  const row = (field: SettingsField) => <FieldRow key={field.key} field={field} entry={snapshot.entries[field.key]} draft={drafts[field.key]} onChange={(value) => setDraft(field.key, value)} />;
  if (hidden) {
    return <section className="settings-group" id={`settings-${group.id}`}>
      <header><h3>{group.title}</h3><p>飞书已关闭：任务只在桌面端下发与查看，已保存的飞书配置保留但不使用。</p></header>
      <div className="settings-rows">{visible.map(row)}</div>
    </section>;
  }
  // 模型分组：当前服务商的 API Key 与专属配置放在最前，其余服务商折叠。
  const forProvider = (field: SettingsField) => (field.providers || (field.provider ? [field.provider] : [])).includes(provider);
  const isOtherProvider = (field: SettingsField) => Boolean(field.providers || field.provider) && !forProvider(field);
  const searching = Boolean(query);
  const primary = visible.filter((field) => searching || (!field.advanced && !isOtherProvider(field)) || (field.provider && forProvider(field)));
  const others = searching ? [] : visible.filter((field) => isOtherProvider(field) && field.type === "secret");
  const advanced = searching ? [] : visible.filter((field) => !primary.includes(field) && !others.includes(field));
  const configuredOthers = others.filter((field) => snapshot.entries[field.key]?.configured).length;
  return <section className="settings-group" id={`settings-${group.id}`}>
    <header><h3>{group.title}</h3>{group.description && <p>{group.description}</p>}</header>
    <div className="settings-rows">{primary.map(row)}</div>
    {others.length > 0 && <details className="settings-more">
      <summary>其他服务商密钥（{others.length} 个{configuredOthers ? `，已配置 ${configuredOthers} 个` : ""}）</summary>
      <div className="settings-rows">{others.map(row)}</div>
    </details>}
    {advanced.length > 0 && <details className="settings-more">
      <summary>高级选项（{advanced.length} 项）</summary>
      <div className="settings-rows">{advanced.map(row)}</div>
    </details>}
  </section>;
}

export function SettingsView({ onSaved, onNotice }: Props) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<"" | "save" | "restart">("");

  useEffect(() => {
    if (!window.desktop?.settings) { setLoadError("运行设置需要在桌面应用中打开"); return; }
    window.desktop.settings.get().then(setSnapshot).catch((error) => setLoadError(String(error?.message || error)));
  }, []);

  const dirtyCount = Object.keys(drafts).length;
  const provider = drafts.PI_AGENT_PROVIDER || snapshot?.entries.PI_AGENT_PROVIDER?.effective || "deepseek";
  const feishuOff = (drafts.FEISHU_ENABLED ?? snapshot?.entries.FEISHU_ENABLED?.effective ?? "true") === "false";
  const groups = snapshot?.groups || [];
  const visibleGroups = useMemo(() => groups.filter((group) => group.fields.some((field) => matches(field, query))), [groups, query]);

  const setDraft = (key: string, value: string | undefined) => setDrafts((current) => {
    const next = { ...current };
    const saved = snapshot?.entries[key]?.value ?? "";
    const isSecret = groups.some((group) => group.fields.some((field) => field.key === key && field.type === "secret"));
    // 与已保存的值相同就不算改动；密钥没有可比较的明文，只要输入或清除就算改动。
    if (value === undefined || (!isSecret && value === saved)) delete next[key];
    else next[key] = value;
    return next;
  });

  const save = async (restart: boolean) => {
    if (!window.desktop?.settings || (!dirtyCount && !restart)) return;
    setSaving(restart ? "restart" : "save");
    try {
      if (dirtyCount) {
        const next = await window.desktop.settings.save(drafts);
        setSnapshot(next);
        setDrafts({});
        onSaved();
      }
      if (restart) {
        onNotice("配置已保存，正在重启本地任务服务…");
        await window.desktop.restartGateway?.();
        onNotice("本地任务服务已重启，新配置已生效");
      } else {
        onNotice("配置已保存，重启本地任务服务后生效");
      }
    } catch (error) {
      onNotice(`保存失败：${String((error as Error)?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")}`);
    } finally {
      setSaving("");
    }
  };

  if (loadError) return <div className="central-view settings-content"><div className="connection-alert" role="alert"><div><strong>无法读取运行设置</strong><span>{loadError}</span></div></div></div>;
  if (!snapshot) return <div className="central-view settings-content"><div className="conversation-empty"><span className="empty-spinner" />正在读取运行设置…</div></div>;

  return (
    <div className="central-view settings-content settings-page">
      <div className="settings-intro"><span className="settings-icon">⚙</span><div><strong>运行设置</strong><p>这里列出网关和 Agent 使用的全部环境配置。密钥用 Windows 系统加密保存在本机；其他配置保存在应用数据目录。留空表示使用默认值或系统环境变量，保存后需要重启本地任务服务才会生效。</p></div></div>
      {!snapshot.encryptionAvailable && <div className="connection-alert" role="alert"><div><strong>系统凭据加密不可用</strong><span>当前系统账户无法使用 Windows 数据保护（DPAPI），密钥既不能保存也不能读取。请用常规 Windows 账户登录后重试。</span></div></div>}
      <div className="settings-toolbar">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索配置项或环境变量名" aria-label="搜索配置项" />
        <nav aria-label="配置分组">{visibleGroups.map((group) => <a key={group.id} href={`#settings-${group.id}`} onClick={(event) => { event.preventDefault(); document.getElementById(`settings-${group.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{group.title}</a>)}</nav>
      </div>
      {visibleGroups.length === 0 && <p className="settings-empty">没有匹配“{query}”的配置项</p>}
      {visibleGroups.map((group) => <GroupSection key={group.id} group={group} snapshot={snapshot} drafts={drafts} query={query} provider={provider} feishuOff={feishuOff} setDraft={setDraft} />)}
      <div className={`settings-savebar ${dirtyCount ? "has-changes" : ""}`}>
        <span>{dirtyCount ? `${dirtyCount} 项未保存` : "没有未保存的更改"}</span>
        <button type="button" className="quiet-button" onClick={() => setDrafts({})} disabled={!dirtyCount || Boolean(saving)}>放弃更改</button>
        <button type="button" className="quiet-button" onClick={() => void save(false)} disabled={!dirtyCount || Boolean(saving)}>{saving === "save" ? "保存中…" : "保存"}</button>
        <button type="button" className="primary-button" onClick={() => void save(true)} disabled={Boolean(saving)}>{saving === "restart" ? "重启中…" : dirtyCount ? "保存并重启服务" : "重启服务"}</button>
      </div>
    </div>
  );
}
