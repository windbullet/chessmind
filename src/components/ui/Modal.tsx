import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose(): void;
  children: ReactNode;
  width?: number;
}

export function Modal({ open, title, subtitle, onClose, children, width }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h2 className="modal-title">{title}</h2>
            {subtitle && <p className="modal-sub" style={{ marginTop: 6 }}>{subtitle}</p>}
          </div>
          <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
