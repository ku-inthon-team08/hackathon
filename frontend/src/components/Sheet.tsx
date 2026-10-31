"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({
  title,
  full,
  onClose,
  children,
}: {
  title: string;
  full?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className={full ? "sheet full" : "sheet"}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="sheet-body">
        <header className="sheet-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
            <X aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
