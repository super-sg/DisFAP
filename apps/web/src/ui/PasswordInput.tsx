import { useState, type InputHTMLAttributes, type JSX } from 'react';
import { IconEye, IconEyeOff } from './Icons.js';
import styles from './ui.module.css';

export interface PasswordInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export function PasswordInput({ mono = true, className = '', ...props }: PasswordInputProps): JSX.Element {
  const [visible, setVisible] = useState(false);

  return (
    <div className={styles.passwordWrap}>
      <input
        type={visible ? 'text' : 'password'}
        className={`${styles.formInput} ${styles.passwordInput} ${mono ? styles.formInputMono : ''} ${className}`}
        {...props}
      />
      <button
        type="button"
        className={styles.passwordToggle}
        onClick={() => setVisible((v) => !v)}
        title={visible ? 'Hide password' : 'Show password'}
        aria-label={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </button>
    </div>
  );
}

