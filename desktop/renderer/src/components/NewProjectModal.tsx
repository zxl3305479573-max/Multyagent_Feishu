import React from "react";

type Props = {
  name: string;
  path: string;
  creating: boolean;
  onNameChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onChooseDirectory: () => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
};

export function NewProjectModal({ name, path, creating, onNameChange, onPathChange, onChooseDirectory, onSubmit, onClose }: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) onClose(); }}>
      <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
        <header><div><h2 id="new-project-title">新建项目</h2><p>项目上下文和任务历史会按项目隔离。</p></div><button className="icon-button" aria-label="关闭" onClick={onClose} disabled={creating}>×</button></header>
        <form onSubmit={onSubmit}>
          <label>项目名<input autoFocus value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：customer-portal" disabled={creating} /></label>
          <label>项目存储路径<span className="path-input-row"><input value={path} onChange={(event) => onPathChange(event.target.value)} placeholder="不填则使用工作区目录" disabled={creating} /><button type="button" className="quiet-button" onClick={onChooseDirectory} disabled={creating}>选择目录</button></span></label>
          <div className="modal-actions"><button type="button" className="quiet-button" onClick={onClose} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating}>{creating ? "创建中…" : "创建项目"}</button></div>
        </form>
      </section>
    </div>
  );
}
