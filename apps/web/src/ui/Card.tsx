import type { HTMLAttributes, JSX, ReactNode } from 'react';
import styles from './ui.module.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  headerAction?: ReactNode;
  interactive?: boolean;
}

export function Card({
  title,
  subtitle,
  headerAction,
  interactive = false,
  children,
  className = '',
  ...props
}: CardProps): JSX.Element {
  return (
    <div
      className={`${styles.card} ${interactive ? styles.cardInteractive : ''} ${className}`}
      {...props}
    >
      {(title || headerAction) && (
        <div className={styles.cardHeader}>
          <div>
            {title && <h3 className={styles.cardTitle}>{title}</h3>}
            {subtitle && (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.78125rem', color: '#94a3b8' }}>
                {subtitle}
              </p>
            )}
          </div>
          {headerAction && <div>{headerAction}</div>}
        </div>
      )}
      <div className={styles.cardBody}>{children}</div>
    </div>
  );
}

