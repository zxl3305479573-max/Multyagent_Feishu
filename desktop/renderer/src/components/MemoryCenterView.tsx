import { useCallback, useEffect, useState } from "react";
import type { MemoryItem } from "../types";
import { formatTime } from "../format";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type Props = { project: string; connected: boolean; request: Request; onNotice: (text: string) => void };

export function MemoryCenterView({ project, connected, request, onNotice }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!connected) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const result = await request<{ items: MemoryItem[] }>("memory_list", { projectName: project || undefined });
      setItems(result.items || []);
    } catch (error) {
      onNotice(`读取记忆失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [connected, onNotice, project, request]);

  useEffect(() => { void load(); }, [load]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? items.filter((item) => `${item.taskTitle} ${item.text} ${item.projectName || ""}`.toLowerCase().includes(needle))
    : items;
  const userCount = items.filter((item) => item.role === "user").length;
  const assistantCount = items.filter((item) => item.role === "assistant").length;

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>长期上下文</span><h2>记忆中心</h2><p>这里展示任务记录中真实保存的对话记忆。当前版本只读，编辑、删除与“已确认/模型推断”分类需要独立记忆后端。</p></div>
      <dl><div><dt>用户输入</dt><dd>{userCount}</dd></div><div><dt>Agent 结果</dt><dd>{assistantCount}</dd></div></dl>
    </section>
    <div className="feature-toolbar">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、项目或记忆内容" aria-label="搜索记忆" />
      <button className="quiet-button" onClick={() => void load()} disabled={loading || !connected}>{loading ? "读取中…" : "刷新"}</button>
    </div>
    {!connected && <div className="feature-empty"><strong>本地任务服务未连接</strong><span>连接网关后才能读取任务记忆。</span></div>}
    {connected && !loading && visible.length === 0 && <div className="feature-empty"><strong>{items.length ? "没有匹配的记忆" : "还没有任务对话记忆"}</strong><span>{items.length ? "换一个关键词再试。" : "完成桌面任务后，用户输入和 Agent 结果会保存在对应任务记录中。"}</span></div>}
    {visible.length > 0 && <div className="memory-grid">{visible.map((item) => <article className="memory-card" key={item.id}>
      <header><span className={`memory-role memory-role-${item.role}`}>{item.role === "assistant" ? "Agent" : "用户"}</span><time>{formatTime(item.at || undefined)}</time></header>
      <strong>{item.taskTitle || item.taskId}</strong>
      <p>{item.text}</p>
      <footer><span>{item.projectName || "未归属项目"}</span><code>{item.taskId}</code></footer>
    </article>)}</div>}
    <p className="feature-note">数据来源：`runtime/domain-tasks.json` 中的任务 `conversation_memory`，通过只读命令 `memory_list` 读取。</p>
  </div>;
}
