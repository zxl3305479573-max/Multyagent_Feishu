import React from "react";
import { Dialog, DialogClose, DialogDescription, DialogTitle } from "./ui/Dialog";

type Props = {
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// 应用内确认框：替代会随操作系统改变样式的 window.confirm。
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog className="confirm-dialog" role="alertdialog" onOpenChange={(open) => { if (!open && !busy) onCancel(); }} ariaDescribedBy="confirm-dialog-description">
      <header>
        <div className="confirm-dialog-heading">
          <span className={`confirm-dialog-icon confirm-dialog-icon-${tone}`} aria-hidden="true">!</span>
          <div><DialogTitle id="confirm-dialog-title">{title}</DialogTitle><DialogDescription id="confirm-dialog-description">{description}</DialogDescription></div>
        </div>
        <DialogClose asChild><button className="icon-button" aria-label="关闭" disabled={busy}>×</button></DialogClose>
      </header>
      <div className="modal-actions confirm-dialog-actions">
        <DialogClose asChild><button type="button" className="quiet-button" disabled={busy}>{cancelLabel}</button></DialogClose>
        <button type="button" className={tone === "danger" ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmLabel}</button>
      </div>
    </Dialog>
  );
}
