import type { HTMLAttributes, JSX, ReactNode } from 'react';
import styles from './ui.module.css';

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  htmlFor?: string;
  error?: string | null;
  help?: ReactNode;
  badge?: ReactNode;
}

export function FormField({
  label,
  htmlFor,
  error,
  help,
  badge,
  children,
  className = '',
  ...props
}: FormFieldProps): JSX.Element {
  return (
    <div className={`${styles.formGroup} ${className}`} {...props}>
      <label className={styles.formLabel} htmlFor={htmlFor}>
        <span>{label}</span>
        {badge}
      </label>
      {children}
      {help && !error && <span className={styles.formHelp}>{help}</span>}
      {error && (
        <span className={styles.formError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

