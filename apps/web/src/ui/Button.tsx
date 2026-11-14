import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import styles from './ui.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps): JSX.Element {
  const variantClass =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'outline'
      ? styles.btnOutline
      : variant === 'ghost'
      ? styles.btnGhost
      : variant === 'danger'
      ? styles.btnDanger
      : styles.btnSecondary;

  const sizeClass = size === 'sm' ? styles.btnSm : size === 'lg' ? styles.btnLg : styles.btnMd;

  return (
    <button
      className={`${styles.btn} ${variantClass} ${sizeClass} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            border: '2px solid currentColor',
            borderRightColor: 'transparent',
            borderRadius: '50%',
            animation: 'dfap-spin 0.6s linear infinite',
          }}
        />
      ) : (
        icon
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
}

