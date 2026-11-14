import type { JSX, ReactNode } from 'react';
import styles from './ui.module.css';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps): JSX.Element {
  return (
    <div className={`${styles.emptyState} ${className}`}>
      <div className={styles.emptyIcon}>{icon}</div>
      <h4 className={styles.emptyTitle}>{title}</h4>
      <p className={styles.emptyDesc}>{description}</p>
      {action}
    </div>
  );
}

