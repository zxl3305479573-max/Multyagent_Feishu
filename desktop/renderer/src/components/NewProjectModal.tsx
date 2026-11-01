import React from "react";
import { Dialog, DialogClose, DialogDescription, DialogTitle } from "./ui/Dialog";

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
    <Dialog onOpenChange={(open) => { if (!open && !creating) onClose(); }} ariaDescribedBy="new-project-description">
      <header><div><DialogTitle id="new-project-title">新建项目</DialogTitle><DialogDescription id="new-project-description">项目上下文和任务历史会按项目隔离。</DialogDescription></div><DialogClose asChild><button className="icon-button" aria-label="关闭" disabled={creating}>×</button></DialogClose></header>
        <form onSubmit={onSubmit}>
          <label>项目名<input autoFocus value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：customer-portal" disabled={creating} /></label>
          <label>项目存储路径<span className="path-input-row"><input value={path} onChange={(event) => onPathChange(event.target.value)} placeholder="不填则使用工作区目录" disabled={creating} /><button type="button" className="quiet-button" onClick={onChooseDirectory} disabled={creating}>选择目录</button></span></label>
          <div className="modal-actions"><button type="button" className="quiet-button" onClick={onClose} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating}>{creating ? "创建中…" : "创建项目"}</button></div>
        </form>
    </Dialog>
  );
}
