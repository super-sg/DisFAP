import type { JSX } from 'react';
import styles from './Navbar.module.css';

export type NavPage = 'landing' | 'dashboard' | 'workspaces';

export interface NavbarProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  /** When true, minimal chrome for active session */
  sessionActive?: boolean;
  /** Present only when the app is running with a real OIDC session. */
  onSignOut?: () => void;
  /** Display-only label (e.g. email) for the signed-in user. */
  userLabel?: string;
}

const NAV_ITEMS: { page: NavPage; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'workspaces', label: 'Workspaces' },
];

export function Navbar({ current, onNavigate, sessionActive, onSignOut, userLabel }: NavbarProps): JSX.Element | null {
  if (sessionActive) return null;

  return (
    <nav className={styles.navbar} role="navigation" aria-label="Main navigation">
      <button className={styles.brand} onClick={() => onNavigate('landing')} type="button" aria-label="DisFAP Home">
        <span className={styles.logoMark} aria-hidden="true">D</span>
        <span className={styles.logoText}>
          Dis<span className={styles.logoAccent}>FAP</span>
        </span>
      </button>

      <ul className={styles.navLinks}>
        {NAV_ITEMS.map(({ page, label }) => (
          <li key={page}>
            <button
              className={styles.navLink}
              data-active={current === page}
              onClick={() => onNavigate(page)}
              type="button"
            >
              {label}
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.navRight}>
        <span className={styles.statusDot} title="System operational" aria-label="System status: operational" />
        {onSignOut ? (
          <button className={styles.userButton} type="button" onClick={onSignOut} aria-label="Sign out">
            <span className={styles.avatar} aria-hidden="true">U</span>
            {userLabel ?? 'Sign out'}
          </button>
        ) : (
          <button className={styles.userButton} type="button" aria-label="User menu">
            <span className={styles.avatar} aria-hidden="true">U</span>
            User
          </button>
        )}
      </div>
    </nav>
  );
}
