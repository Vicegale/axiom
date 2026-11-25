import { useEffect, useRef } from "react";

interface Props {
  /** Called for Escape and for a click on the backdrop. */
  onClose: () => void;
  /** The accessible name when there is no visible heading. */
  label?: string;
  labelledBy?: string;
  /** "alertdialog" for confirmations. */
  role?: "dialog" | "alertdialog";
  className?: string;
  children: React.ReactNode;
}

/**
 * A native modal `<dialog>`: the browser traps focus, makes the rest of the page inert and closes
 * on Escape. Mounting it opens it; unmounting closes it and returns focus to whatever had focus
 * before (the control that opened it).
 */
export function Modal({ onClose, label, labelledBy, role, className, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dlg.open) dlg.showModal();
    return () => {
      if (dlg.open) dlg.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled natively (`cancel`)
    <dialog
      ref={ref}
      role={role}
      className={className}
      aria-label={label}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      {children}
    </dialog>
  );
}
