import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

type Props = { children: ReactNode; open?: boolean; onOpenChange: (open: boolean) => void; className?: string; ariaDescribedBy?: string };

/** Shared accessible modal shell. Radix owns focus restoration, Escape and focus trapping. */
export function Dialog({ children, open = true, onOpenChange, className = "", ariaDescribedBy }: Props) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content className={`ui-dialog-content project-modal ${className}`} aria-describedby={ariaDescribedBy}>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
