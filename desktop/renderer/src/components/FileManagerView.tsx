import { useCallback, useEffect, useState } from "react";
import type { WorkspaceFileItem } from "../types";
import { formatFileSize, formatTime } from "../format";

type Request = <T = unknown>(command: string, payload?: Record<string, unknown>) => Promise<T>;
type Props = { project: string; connected: boolean; request: Request; onNotice: (text: string) => void };

export function FileManagerView({ project, connected, request, onNotice }: Props) {
  const [files, setFiles] = useState<WorkspaceFileItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!connected) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const result = await request<{ files: WorkspaceFileItem[] }>("workspace_files", { projectName: project || undefined });
      setFiles(result.files || []);
    } catch (error) {
      onNotice(`读取文件失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [connected, onNotice, project, request]);

  useEffect(() => { void load(); }, [load]);

  async function openFile(item: WorkspaceFileItem) {
    if (!window.desktop?.openFile) {
      onNotice("请在桌面应用中打开文件");
      return;
    }
    const result = await window.desktop.openFile(item.path, item.projectName || project);
    if (!result.opened) onNotice(`文件无法打开：${result.error || item.path}`);
  }

  const needle = query.trim().toLowerCase();
  const visible = needle ? files.filter((item) => `${item.path} ${item.description || ""} ${item.projectName || ""}`.toLowerCase().includes(needle)) : files;
  const totalSize = files.reduce((sum, item) => sum + (item.size || 0), 0);

  return <div className="central-view settings-content feature-page">
    <section className="feature-hero">
      <div><span>任务产物与文件事件</span><h2>文件管理</h2><p>从真实任务事件中汇总交付产物、写入文件与验收证据。当前版本不提供上传、删除或完整目录浏览。</p></div>
      <dl><div><dt>文件引用</dt><dd>{files.length}</dd></div><div><dt>已知大小</dt><dd>{totalSize ? formatFileSize(totalSize) : "—"}</dd></div></dl>
    </section>
    <div className="feature-toolbar">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件路径、项目或说明" aria-label="搜索文件" />
      <button className="quiet-button" onClick={() => void load()} disabled={loading || !connected}>{loading ? "读取中…" : "刷新"}</button>
    </div>
    {!connected && <div className="feature-empty"><strong>本地任务服务未连接</strong><span>连接网关后才能汇总任务文件。</span></div>}
    {connected && !loading && visible.length === 0 && <div className="feature-empty"><strong>{files.length ? "没有匹配的文件" : "还没有任务文件记录"}</strong><span>{files.length ? "换一个关键词再试。" : "任务产生交付、文件写入或验收证据后，会出现在这里。"}</span></div>}
    {visible.length > 0 && <div className="file-list">{visible.map((item) => <article className="file-row" key={`${item.projectName || ""}:${item.path}`}>
      <div className="file-row-icon" aria-hidden="true">▤</div>
      <div className="file-row-main">
        <strong title={item.path}>{item.path}</strong>
        <span>{item.description || "任务事件中记录的文件引用"}</span>
        <small>{item.projectName || "未归属项目"} · {item.taskId || "未知任务"} · {formatTime(item.timestamp || undefined)}</small>
      </div>
      <span className="file-row-size">{item.size ? formatFileSize(item.size) : "—"}</span>
      <button className="quiet-button" onClick={() => void openFile(item)}>打开</button>
    </article>)}</div>}
    <p className="feature-note">数据来源：`runtime/events.jsonl` 中的 `artifact_paths`、`artifact_items`、`file_path` 与验收证据路径，通过只读命令 `workspace_files` 汇总；打开文件仍走 `desktop:open-file`。</p>
  </div>;
}
