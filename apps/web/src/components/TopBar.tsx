import type { JSX } from 'react';
import type { NavPage } from './Sidebar.js';
import styles from './TopBar.module.css';

export interface TopBarProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  userLabel?: string;
  onSwitchUser?: () => void;
  onSignOut?: () => void;
}

const PAGE_TITLES: Record<NavPage, string> = {
  landing: 'Overview',
  dashboard: 'Dashboard',
  workspaces: 'Software Marketplace',
  owner: 'Owner Management Console',
  'list-software': 'Publish Software Listing',
  sessions: 'Active Sessions & Workspaces',
  activity: 'Rental Activity & Ledger',
  security: 'Security controls',
};

export function TopBar({
  current,
  onNavigate,
  userLabel,
  onSwitchUser,
  onSignOut,
}: TopBarProps): JSX.Element {
  return (
    <header className={styles.topBar} role="banner">
      <div className={styles.leftSection}>
        <div className={styles.breadcrumbs} aria-label="Breadcrumb">
          <span className={styles.breadcrumbSegment}>DisFAP</span>
          <span>/</span>
          <span className={styles.breadcrumbActive}>{PAGE_TITLES[current] ?? 'Platform'}</span>
        </div>

        {/* Primary E2E Test Compatibility & Fast Navigation */}
        <nav className={styles.quickNav} aria-label="Quick navigation">
          <button
            type="button"
            className={`${styles.quickBtn} ${current === 'dashboard' ? styles.quickBtnActive : ''}`}
            onClick={() => onNavigate('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`${styles.quickBtn} ${current === 'workspaces' ? styles.quickBtnActive : ''}`}
            onClick={() => onNavigate('workspaces')}
          >
            Workspaces
          </button>
        </nav>
      </div>

      <div className={styles.rightSection}>
        {onSwitchUser ? (
          <button
            type="button"
            className={styles.roleTag}
            onClick={onSwitchUser}
            title="Click to switch persona (Owner / Renter)"
          >
            <span>{userLabel ?? 'Switch Persona'}</span>
            <span style={{ fontSize: '0.6875rem', color: '#38bdf8' }}>⇄</span>
          </button>
        ) : onSignOut ? (
          <button
            type="button"
            className={styles.roleTag}
            onClick={onSignOut}
            title="Sign out of DisFAP"
          >
            <span>{userLabel ?? 'Sign out'}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

