import type { JSX } from 'react';
import { BrandMark } from '../ui/BrandMark.js';
import styles from './AuthGate.module.css';

export interface AuthGateProps {
  /** A callback/login error to surface, if any. */
  error: string | null;
  /** True while a redirect is in flight (or the callback is being processed). */
  pending: boolean;
  onSignIn: () => void;
}

/**
 * Full-page gate rendered when OIDC is configured but the user is not
 * authenticated. It never falls through to the app shell: an unauthenticated
 * user must not be shown a UI that implies access.
 */
export function AuthGate({ error, pending, onSignIn }: AuthGateProps): JSX.Element {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-live="polite">
        <div className={styles.brandRow}>
          <BrandMark size={32} />
          <span className={styles.brandText}>
            Dis<span className={styles.brandAccent}>FAP</span>
          </span>
        </div>
        <h1 className={styles.title}>Sign in to DisFAP Platform</h1>
        <p className={styles.subtitle}>
          Sign in with the configured OIDC identity provider to access the workspace control plane.
        </p>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button className={styles.button} type="button" onClick={onSignIn} disabled={pending}>
          {pending ? 'Authorizing with OIDC Provider…' : 'Authenticate via Single Sign-On'}
        </button>
      </section>
    </main>
  );
}
