import { useEffect, type JSX, type ReactNode } from 'react';
import { IconX } from './Icons.js';
import styles from './ui.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 540,
}: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={styles.modalContent}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h3 className={styles.cardTitle}>{title}</h3>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={onClose}
            style={{ padding: 4, borderRadius: 4, cursor: 'pointer' }}
            aria-label="Close dialog"
          >
            <IconX size={18} />
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFooter}>{footer}</div>}
      </div>
    </div>
  );
}

