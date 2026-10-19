import React, { useEffect, useMemo, useRef, useState } from "react";
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

type Subsection = { id: string; title: string; description?: string; order: number };

const MODEL_SELECTION_KEYS = new Set(["PI_AGENT_PROVIDER", "PI_AGENT_MODEL", "PI_AGENT_THINKING"]);
const MODEL_CONNECTION_KEYS = new Set(["PI_AGENT_BASE_URL", "PI_AGENT_API_TYPE", "PI_AGENT_API_KEY", "PI_AGENT_MODELS_FILE"]);
const MODEL_CAPABILITY_KEYS = new Set(["PI_AGENT_MODEL_NAME", "PI_AGENT_CONTEXT_WINDOW", "PI_AGENT_MAX_TOKENS", "PI_AGENT_MODEL_REASONING", "PI_AGENT_SUPPORTS_DEVELOPER_ROLE", "PI_AGENT_SUPPORTS_REASONING_EFFORT"]);

function subsectionFor(groupId: string, field: SettingsField): Subsection {
  if (groupId === "feishu") {
    if (field.key === "FEISHU_ENABLED") return { id: "switch", title: "接入开关", description: "决定本次运行是否连接飞书。", order: 10 };
    if (field.role) return { id: "credentials", title: "机器人凭据", description: "每个角色使用独立的自建应用；留空的角色只在桌面端可用。", order: 20 };
    return { id: "routing", title: "群聊路由", description: "限制机器人响应范围。", order: 30 };
  }
  if (groupId === "model") {
    if (MODEL_SELECTION_KEYS.has(field.key)) return { id: "selection", title: "模型选择", description: "当前所有 Agent 共用的服务商、模型和思考强度。", order: 10 };
    if (MODEL_CONNECTION_KEYS.has(field.key)) return { id: "connection", title: "自定义连接", description: "接入 Ollama、vLLM、LM Studio 或兼容网关时填写。", order: 20 };
    if (MODEL_CAPABILITY_KEYS.has(field.key)) return { id: "capabilities", title: "模型能力与兼容", description: "按模型实际能力填写，用于正确选择上下文和推理参数。", order: 30 };
    if (field.providers || field.provider) {
      return field.type === "secret"
        ? { id: "provider-keys", title: "服务商凭据", description: "当前服务商使用的 API Key；其他服务商密钥收纳在下方。", order: 40 }
        : { id: "provider-options", title: "服务商专有配置", description: "当前服务商需要额外填写的连接参数。", order: 50 };
    }
    return { id: "other", title: "其他模型参数", order: 60 };
  }
  if (groupId === "profile") return { id: "identity", title: "个人称呼", description: "设置桌面工作台里用于识别你的称呼。", order: 10 };
  if (groupId === "agent") {
    if (["PI_AGENT_RUNTIME", "PI_RPC_COMMAND", "PI_AGENT_WORKTREE"].includes(field.key)) return { id: "execution", title: "执行方式", description: "控制 Pi 在进程内运行，还是拆到独立 RPC 子进程。", order: 10 };
    if (["PI_CONFIRM_ROLES", "PI_DIAGRAM_ROLES", "PI_DIAGRAM_SKILL_PATH", "PI_ARCHITECT_DIAGRAM_SKILL_PATH"].includes(field.key)) return { id: "collaboration", title: "协作与展示", description: "人工确认节点与架构图能力。", order: 20 };
    return { id: "limits", title: "限制与超时", description: "防止任务循环，并控制会话和审批的有效期。", order: 30 };
  }
  if (groupId === "tickets") return { id: "access", title: "GitHub 访问凭据", description: "工单源的具体仓库与过滤规则在桌面端「工单」页配置。", order: 10 };
  if (groupId === "bitable") {
    if (["FEISHU_BITABLE_WIKI_TOKEN", "FEISHU_BITABLE_APP_TOKEN", "FEISHU_BITABLE_TABLE_ID", "FEISHU_BITABLE_TRACE_TABLE_ID", "FEISHU_BITABLE_RECORDS_FILE", "FEISHU_BITABLE_TRACE_RECORDS_FILE"].includes(field.key)) return { id: "connection", title: "表格连接", description: "目标多维表格、Trace 表与本地行映射。", order: 10 };
    return { id: "sync", title: "同步、更新与重试", description: "控制字段补齐、控制指令轮询和网络退避。", order: 20 };
  }
  if (groupId === "runtime") {
    if (field.key.includes("FILE") || field.key === "PI_DATA_DIR" || field.key === "PI_LOCK_DIR" || field.key === "MULTYAGENT_LEGACY_ENV_FILE") return { id: "storage", title: "数据与文件", description: "任务、事件、检查点和项目数据的落盘位置。", order: 10 };
    return { id: "process", title: "日志与进程", description: "日志归档、退出、端口和桌面控制面。", order: 20 };
  }
  return { id: "settings", title: "配置项", order: 10 };
}

type SettingsPage = {
  key: string;
  groupId: string;
  groupTitle: string;
  groupDescription?: string;
  section: Subsection;
  fields: SettingsField[];
};

function buildSettingsPages(groups: SettingsGroup[], query: string, provider: string, feishuOff: boolean): SettingsPage[] {
  const pages: SettingsPage[] = [];
  for (const group of groups) {
    const hidden = feishuOff && FEISHU_GROUPS.has(group.id);
    const visible = group.fields.filter((field) => matches(field, query) && (!hidden || field.key === "FEISHU_ENABLED"));
    if (!visible.length) continue;
    const forProvider = (field: SettingsField) => (field.providers || (field.provider ? [field.provider] : [])).includes(provider);
    const isOtherProvider = (field: SettingsField) => Boolean(field.providers || field.provider) && !forProvider(field);
    const searching = Boolean(query);
    const otherProviderKeys = searching ? [] : visible.filter((field) => isOtherProvider(field) && field.type === "secret");
    const relevant = visible.filter((field) => searching || !isOtherProvider(field));
    const sections = new Map<string, { section: Subsection; fields: SettingsField[] }>();
    for (const field of relevant) {
      const section = subsectionFor(group.id, field);
      const current = sections.get(section.id) || { section, fields: [] };
      current.fields.push(field);
      sections.set(section.id, current);
    }
    for (const { section, fields } of [...sections.values()].sort((left, right) => left.section.order - right.section.order)) {
      pages.push({
        key: `${group.id}:${section.id}`,
        groupId: group.id,
        groupTitle: group.title,
        groupDescription: hidden ? "飞书已关闭：任务只在桌面端下发与查看，已保存的飞书配置保留但不使用。" : group.description,
        section,
        fields,
      });
    }
    if (otherProviderKeys.length > 0) {
      pages.push({
        key: `${group.id}:other-provider-keys`,
        groupId: group.id,
        groupTitle: group.title,
        groupDescription: group.description,
        section: { id: "other-provider-keys", title: "其他服务商密钥", description: "已配置或备用的其他模型服务商密钥。", order: 90 },
        fields: otherProviderKeys,
      });
    }
  }
  return pages;
}

export function SettingsView({ onSaved, onNotice }: Props) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<"" | "save" | "restart">("");
  const [activePage, setActivePage] = useState("");
  const pageTopRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!window.desktop?.settings) { setLoadError("运行设置需要在桌面应用中打开"); return; }
    window.desktop.settings.get().then(setSnapshot).catch((error) => setLoadError(String(error?.message || error)));
  }, []);

  const dirtyCount = Object.keys(drafts).length;
  const provider = drafts.PI_AGENT_PROVIDER || snapshot?.entries.PI_AGENT_PROVIDER?.effective || "deepseek";
  const feishuOff = (drafts.FEISHU_ENABLED ?? snapshot?.entries.FEISHU_ENABLED?.effective ?? "true") === "false";
  const groups = snapshot?.groups || [];
  const pages = useMemo(() => buildSettingsPages(groups, query, provider, feishuOff), [groups, query, provider, feishuOff]);
  const navigation = useMemo(() => {
    const grouped = new Map<string, { title: string; pages: SettingsPage[] }>();
    for (const page of pages) {
      const current = grouped.get(page.groupId) || { title: page.groupTitle, pages: [] };
      current.pages.push(page);
      grouped.set(page.groupId, current);
    }
    return [...grouped.values()];
  }, [pages]);
  const currentPage = pages.find((page) => page.key === activePage) || pages[0] || null;

  useEffect(() => {
    if (!pages.length) {
      setActivePage("");
      return;
    }
    if (!pages.some((page) => page.key === activePage)) setActivePage(pages[0].key);
  }, [pages, activePage]);

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

  const selectPage = (key: string) => {
    setActivePage(key);
    requestAnimationFrame(() => {
      const scroller = pageTopRef.current?.closest<HTMLElement>(".settings-detail");
      scroller?.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  if (loadError) return <div className="central-view settings-content"><div className="connection-alert" role="alert"><div><strong>无法读取运行设置</strong><span>{loadError}</span></div></div></div>;
  if (!snapshot) return <div className="central-view settings-content"><div className="conversation-empty"><span className="empty-spinner" />正在读取运行设置…</div></div>;

  return (
    <div className="central-view settings-content settings-page">
      <div className="settings-intro"><span className="settings-icon">⚙</span><div><strong>运行设置</strong><p>这里列出网关和 Agent 使用的全部环境配置。密钥用 Windows 系统加密保存在本机；其他配置保存在应用数据目录。留空表示使用默认值或系统环境变量，保存后需要重启本地任务服务才会生效。</p></div></div>
      {!snapshot.encryptionAvailable && <div className="connection-alert" role="alert"><div><strong>系统凭据加密不可用</strong><span>当前系统账户无法使用 Windows 数据保护（DPAPI），密钥既不能保存也不能读取。请用常规 Windows 账户登录后重试。</span></div></div>}
      <div className="settings-toolbar settings-searchbar">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索配置项、二级标题或环境变量名" aria-label="搜索配置项" />
        <span>{query ? `匹配 ${pages.length} 个二级页面` : `共 ${pages.length} 个二级页面`}</span>
      </div>
      {pages.length === 0 && <p className="settings-empty">没有匹配“{query}”的配置项</p>}
      {pages.length > 0 && <div className="settings-layout">
        <aside className="settings-section-nav" aria-label="运行设置二级目录">
          <div className="settings-section-nav-title">配置目录</div>
          {navigation.map((group) => <section key={group.title} className="settings-nav-group">
            <h3>{group.title}</h3>
            <div>{group.pages.map((page) => <button key={page.key} type="button" className={currentPage?.key === page.key ? "is-selected" : ""} aria-current={currentPage?.key === page.key ? "page" : undefined} onClick={() => selectPage(page.key)}>
              <span>{page.section.title}</span><small>{page.fields.length}</small>
            </button>)}</div>
          </section>)}
        </aside>
        {currentPage && <section className="settings-detail" ref={pageTopRef}>
          <header className="settings-detail-heading">
            <span>{currentPage.groupTitle}</span>
            <h2>{currentPage.section.title}</h2>
            {(currentPage.section.description || currentPage.groupDescription) && <p>{currentPage.section.description || currentPage.groupDescription}</p>}
          </header>
          <div className="settings-rows">{currentPage.fields.map((field) => <FieldRow key={field.key} field={field} entry={snapshot.entries[field.key]} draft={drafts[field.key]} onChange={(value) => setDraft(field.key, value)} />)}</div>
          <div className={`settings-savebar ${dirtyCount ? "has-changes" : ""}`}>
            <span>{dirtyCount ? `${dirtyCount} 项未保存` : "没有未保存的更改"}</span>
            <button type="button" className="quiet-button" onClick={() => setDrafts({})} disabled={!dirtyCount || Boolean(saving)}>放弃更改</button>
            <button type="button" className="quiet-button" onClick={() => void save(false)} disabled={!dirtyCount || Boolean(saving)}>{saving === "save" ? "保存中…" : "保存"}</button>
            <button type="button" className="primary-button" onClick={() => void save(true)} disabled={Boolean(saving)}>{saving === "restart" ? "重启中…" : dirtyCount ? "保存并重启服务" : "重启服务"}</button>
          </div>
        </section>}
      </div>}
    </div>
  );
}
