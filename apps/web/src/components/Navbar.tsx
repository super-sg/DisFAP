import type { JSX } from 'react';
import { BrandMark } from '../ui/BrandMark.js';
import styles from './Navbar.module.css';

export type NavPage =
  | 'landing'
  | 'dashboard'
  | 'workspaces'
  | 'owner'
  | 'list-software'
  | 'sessions'
  | 'activity'
  | 'security';

export interface NavbarProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  sessionActive?: boolean;
  onSignOut?: () => void;
  onSwitchUser?: () => void;
  userLabel?: string;
  isOwner?: boolean;
}

const NAV_ITEMS: { page: NavPage; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'workspaces', label: 'Workspaces' },
];

export function Navbar({
  current,
  onNavigate,
  sessionActive,
  onSignOut,
  onSwitchUser,
  userLabel,
}: NavbarProps): JSX.Element | null {
  if (sessionActive) return null;

  return (
    <nav className={styles.navbar} role="navigation" aria-label="Main navigation">
      <button
        className={styles.brand}
        onClick={() => onNavigate('landing')}
        type="button"
        aria-label="DisFAP Home"
      >
        <BrandMark size={24} />
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
        {onSignOut ? (
          <button
            className={styles.userButton}
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
          >
            <span className={styles.avatar} aria-hidden="true">
              U
            </span>
            {userLabel ?? 'Sign out'}
          </button>
        ) : onSwitchUser ? (
          <button
            className={styles.userButton}
            type="button"
            onClick={onSwitchUser}
            aria-label="Switch demo user"
            title="Switch demo user"
          >
            <span className={styles.avatar} aria-hidden="true">
              U
            </span>
            {userLabel ?? 'Switch user'}
          </button>
        ) : (
          <button className={styles.userButton} type="button" aria-label="User menu">
            <span className={styles.avatar} aria-hidden="true">
              U
            </span>
            {userLabel ?? 'User'}
          </button>
        )}
      </div>
    </nav>
  );
}
