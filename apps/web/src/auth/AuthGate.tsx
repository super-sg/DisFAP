import type { JSX } from 'react';
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
        <div className={styles.mark} aria-hidden="true">D</div>
        <h1 className={styles.title}>Sign in to DisFAP</h1>
        <p className={styles.subtitle}>Authentication is required to access workspaces.</p>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button className={styles.button} type="button" onClick={onSignIn} disabled={pending}>
          {pending ? 'Redirecting…' : 'Sign in'}
        </button>
      </section>
    </main>
  );
}
