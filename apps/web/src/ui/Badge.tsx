import type { HTMLAttributes, JSX, ReactNode } from 'react';
import styles from './ui.module.css';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'warning' | 'danger' | 'neutral' | 'accent';
  dot?: boolean;
  pulse?: boolean;
  icon?: ReactNode;
}

export function Badge({
  variant = 'neutral',
  dot = false,
  pulse = false,
  icon,
  children,
  className = '',
  ...props
}: BadgeProps): JSX.Element {
  const variantClass =
    variant === 'success'
      ? styles.badgeSuccess
      : variant === 'warning'
      ? styles.badgeWarning
      : variant === 'danger'
      ? styles.badgeDanger
      : variant === 'accent'
      ? styles.badgeAccent
      : styles.badgeNeutral;

  return (
    <span className={`${styles.badge} ${variantClass} ${className}`} {...props}>
      {dot && (
        <span
          className={`${styles.badgeDot} ${pulse ? styles.badgeDotPulsing : ''}`}
          aria-hidden="true"
        />
      )}
      {icon}
      {children}
    </span>
  );
}

