import React, { useCallback, useEffect, useState } from "react";
import type { Ticket, TicketSource } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;

type Props = {
  project: string;
  projects: string[];
  connected: boolean;
  request: Request;
  onNotice: (text: string) => void;
  onOpenTask: (taskId: string) => void;
};

const THRESHOLDS: Record<string, string> = { severe: "只拉紧急", major: "紧急 + 高", all: "紧急 + 高 + 未设置" };
const STATUS: Record<string, string> = { new: "未处理", awaiting_confirmation: "待飞书确认", dispatched: "处理中", completed: "已完成", failed: "失败", cancelled: "已终止", ignored: "已忽略" };

const emptySource = (project: string): TicketSource => ({
  id: "", repo: "", project, labels: [], assignee: "", autoClose: false,
  pull: { enabled: false, everyHours: 4, threshold: "major", confirmInFeishu: true, chatId: "" },
});

// 工单收件箱：配置 GitHub 仓库 → 本地项目的工单源，查看待办，把工单交给项目经理；可开启定时拉单。
export function TicketsView({ project, projects, connected, request, onNotice, onOpenTask }: Props) {
  const [sources, setSources] = useState<TicketSource[]>([]);
  const [hasToken, setHasToken] = useState(true);
  const [activeId, setActiveId] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [draft, setDraft] = useState<TicketSource | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState("");
  const [removeTarget, setRemoveTarget] = useState<TicketSource | null>(null);
  const scope = project ? { projectName: project } : {};
  const active = sources.find((source) => source.id === activeId) || null;

  const loadSources = useCallback(async () => {
    try {
      const result = await request<{ sources: TicketSource[]; hasToken: boolean }>("tickets_sources", project ? { projectName: project } : {});
      setSources(result.sources);
      setHasToken(result.hasToken);
      setActiveId((current) => result.sources.some((source) => source.id === current) ? current : result.sources[0]?.id || "");
    } catch (error) { onNotice(`读取工单源失败：${(error as Error).message}`); }
  }, [project, request, onNotice]);

  const loadInbox = useCallback(async (source: TicketSource | null) => {
    if (!source) { setTickets([]); return; }
    setBusy("inbox");
    try {
      const result = await request<{ tickets: Ticket[] }>("tickets_inbox", { sourceId: source.id, projectName: source.project });
      setTickets(result.tickets);
    } catch (error) { setTickets([]); onNotice(`拉取工单失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }, [request, onNotice]);

  useEffect(() => { if (connected) void loadSources(); }, [connected, loadSources]);
  // 只在切换工单源（或其仓库被修改）时重新拉取，工单源列表刷新本身不触发。
  useEffect(() => { if (connected) void loadInbox(active); }, [connected, activeId, active?.repo, loadInbox]);

  async function saveDraft() {
    if (!draft) return;
    setBusy("save");
    try {
      const { source } = await request<{ source: TicketSource }>("tickets_save_source", { ...scope, source: draft });
      setDraft(null);
      setActiveId(source.id);
      await loadSources();
      onNotice(`已保存工单源：${source.repo}`);
    } catch (error) { onNotice(`保存失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  function removeSource(source: TicketSource) {
    setRemoveTarget(source);
  }

  async function confirmRemoveSource() {
    if (!removeTarget) return;
    const source = removeTarget;
    setRemoveTarget(null);
    try {
      setBusy("remove");
      await request("tickets_remove_source", { sourceId: source.id, projectName: source.project });
      await loadSources();
    } catch (error) { onNotice(`移除失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function dispatch(ticket: Ticket) {
    if (!active) return;
    setBusy(`dispatch-${ticket.number}`);
    try {
      const result = await request<{ taskId: string; duplicate: boolean }>("tickets_dispatch", { sourceId: active.id, projectName: active.project, number: ticket.number, note: notes[ticket.number] || "" });
      onNotice(result.duplicate ? `#${ticket.number} 已在处理中` : `#${ticket.number} 已交给项目经理`);
      await loadInbox(active);
    } catch (error) { onNotice(`派发失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  async function pullNow() {
    if (!active) return;
    setBusy("pull");
    try {
      const result = await request<{ summary: string }>("tickets_pull", { sourceId: active.id, projectName: active.project });
      onNotice(result.summary);
      await loadSources();
      await loadInbox(active);
    } catch (error) { onNotice(`拉单失败：${(error as Error).message}`); }
    finally { setBusy(""); }
  }

  const updatePull = (patch: Partial<TicketSource["pull"]>) => setDraft((current) => current && { ...current, pull: { ...current.pull, ...patch } });

  return (
    <div className="central-view settings-content tickets-view">
      {!hasToken && <div className="setup-hint"><span>尚未配置 GITHUB_TOKEN，请在运行设置「GitHub 工单」中填写后重启服务。</span></div>}
      <div className="tickets-sources">
        {sources.map((source) => <button key={source.id} className={`ticket-source ${source.id === activeId ? "is-selected" : ""}`} onClick={() => setActiveId(source.id)}>
          <strong>{source.repo}</strong><span>{source.project}{source.pull.enabled ? ` · 每 ${source.pull.everyHours} 小时拉单` : ""}</span>
        </button>)}
        <button className="ticket-source ticket-source-add" disabled={!connected} onClick={() => setDraft(emptySource(project || projects[0] || ""))}>＋ 添加工单源</button>
      </div>

      {draft && <section className="ticket-form">
        <h3>{draft.id ? "编辑工单源" : "添加工单源"}</h3>
        <label>GitHub 仓库<input value={draft.repo} placeholder="owner/name" onChange={(event) => setDraft({ ...draft, repo: event.target.value })} /></label>
        <label>交给哪个本地项目<select value={draft.project} disabled={Boolean(project)} onChange={(event) => setDraft({ ...draft, project: event.target.value })}>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>只看这些标签（逗号分隔，可空）<input value={draft.labels.join(",")} onChange={(event) => setDraft({ ...draft, labels: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
        <label>只看指派给（GitHub 用户名，可空）<input value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.target.value })} /></label>
        <label className="ticket-check"><input type="checkbox" checked={draft.autoClose} onChange={(event) => setDraft({ ...draft, autoClose: event.target.checked })} />任务完成且验收通过后自动关闭 Issue</label>
        <label className="ticket-check"><input type="checkbox" checked={draft.pull.enabled} onChange={(event) => updatePull({ enabled: event.target.checked })} />定时拉单</label>
        {draft.pull.enabled && <div className="ticket-pull-fields">
          <label>间隔（小时）<input type="number" min={1} max={24} value={draft.pull.everyHours} onChange={(event) => updatePull({ everyHours: Number(event.target.value) })} /></label>
          <label>优先级门槛<select value={draft.pull.threshold} onChange={(event) => updatePull({ threshold: event.target.value as TicketSource["pull"]["threshold"] })}>{Object.entries(THRESHOLDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="ticket-check"><input type="checkbox" checked={draft.pull.confirmInFeishu} onChange={(event) => updatePull({ confirmInFeishu: event.target.checked })} />先推飞书确认卡，点「交给项目经理」才开工</label>
          {draft.pull.confirmInFeishu && <label>飞书群 chat_id（留空用 FEISHU_ALLOWED_CHAT_ID）<input value={draft.pull.chatId} onChange={(event) => updatePull({ chatId: event.target.value })} /></label>}
        </div>}
        <div className="ticket-form-actions"><button className="quiet-button" onClick={() => setDraft(null)}>取消</button><button className="project-action-button" disabled={busy === "save"} onClick={() => void saveDraft()}>{busy === "save" ? "保存中…" : "保存"}</button></div>
      </section>}

      {active && !draft && <section className="ticket-inbox">
        <div className="ticket-inbox-heading">
          <div><h3>{active.repo}</h3><small>{active.pull.enabled ? `定时拉单：每 ${active.pull.everyHours} 小时 · ${THRESHOLDS[active.pull.threshold]}${active.pull.lastResult ? ` · 上次：${active.pull.lastResult}` : ""}` : "未开启定时拉单"}</small></div>
          <div className="ticket-inbox-actions">
            <button className="quiet-button" onClick={() => setDraft({ ...active })}>编辑</button>
            <button className="quiet-button" onClick={() => void removeSource(active)}>移除</button>
            <button className="quiet-button" disabled={Boolean(busy)} onClick={() => void loadInbox(active)}>{busy === "inbox" ? "刷新中…" : "刷新"}</button>
            <button className="project-action-button" disabled={Boolean(busy)} onClick={() => void pullNow()}>{busy === "pull" ? "拉单中…" : "立即拉单"}</button>
          </div>
        </div>
        {tickets.length === 0 && busy !== "inbox" && <p className="ticket-empty">没有打开的工单。</p>}
        {tickets.map((ticket) => <article key={ticket.number} className={`ticket-row priority-${ticket.priority.rank}`}>
          <div className="ticket-row-main">
            <span className="ticket-priority">{ticket.priority.label}</span>
            <strong>#{ticket.number} {ticket.title}</strong>
            <span className={`ticket-status status-${ticket.status}`}>{STATUS[ticket.status] || ticket.status}</span>
          </div>
          {ticket.labels.length > 0 && <div className="message-tags">{ticket.labels.map((label) => <span key={label}>{label}</span>)}</div>}
          {ticket.body && <p className="ticket-body">{ticket.body}</p>}
          <div className="ticket-row-actions">
            {ticket.taskId && <button className="quiet-button" onClick={() => onOpenTask(ticket.taskId!)}>查看任务</button>}
            {ticket.status !== "dispatched" && <>
              <input placeholder="补充说明（可选）" value={notes[ticket.number] || ""} onChange={(event) => setNotes({ ...notes, [ticket.number]: event.target.value })} />
              <button className="project-action-button" disabled={Boolean(busy)} onClick={() => void dispatch(ticket)}>{busy === `dispatch-${ticket.number}` ? "派发中…" : ticket.status === "new" || ticket.status === "awaiting_confirmation" ? "交给项目经理" : "重新交给项目经理"}</button>
            </>}
          </div>
        </article>)}
      </section>}
      {!active && !draft && <p className="ticket-empty">还没有工单源。添加一个 GitHub 仓库，把 Issues 接到项目经理。</p>}
      {removeTarget && <ConfirmDialog
        title="移除工单源？"
        description={<>将停止从 <strong>{removeTarget.repo}</strong> 拉取新工单。已派发的任务不受影响。</>}
        confirmLabel="确认移除"
        tone="danger"
        onConfirm={() => void confirmRemoveSource()}
        onCancel={() => setRemoveTarget(null)}
      />}
    </div>
  );
}
