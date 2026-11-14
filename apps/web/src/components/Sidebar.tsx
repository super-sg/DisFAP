import type { JSX } from 'react';
import { BrandMark } from '../ui/BrandMark.js';
import {
  IconBox,
  IconCpu,
  IconKey,
  IconLaptop,
  IconLayers,
  IconLogOut,
  IconRefresh,
  IconServer,
  IconShield,
  IconTerminal,
  IconUser,
} from '../ui/Icons.js';
import styles from './Sidebar.module.css';

export type NavPage =
  | 'landing'
  | 'dashboard'
  | 'workspaces'
  | 'owner'
  | 'list-software'
  | 'sessions'
  | 'activity'
  | 'security';

export interface SidebarProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  isOwner?: boolean;
  userLabel?: string;
  onSignOut?: () => void;
  onSwitchUser?: () => void;
}

export function Sidebar({
  current,
  onNavigate,
  isOwner = false,
  userLabel = 'User',
  onSignOut,
  onSwitchUser,
}: SidebarProps): JSX.Element {
  return (
    <aside className={styles.sidebar} aria-label="Application sidebar">
      <div className={styles.brandWrap}>
        <button
          type="button"
          className={styles.brand}
          onClick={() => onNavigate('landing')}
          aria-label="DisFAP Overview"
        >
          <BrandMark size={26} />
          <span className={styles.brandTitle}>
            Dis<span className={styles.brandAccent}>FAP</span>
          </span>
        </button>
        <span className={styles.brandVersion}>v1.0-e2e</span>
      </div>

      <div className={styles.navSections}>
        <div className={styles.navGroup}>
          <div className={styles.groupHeader}>Workspaces</div>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'dashboard' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('dashboard')}
          >
            <span className={styles.navItemLeft}>
              <IconServer size={16} className={styles.navItemIcon} />
              <span>Overview</span>
            </span>
          </button>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'workspaces' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('workspaces')}
          >
            <span className={styles.navItemLeft}>
              <IconLayers size={16} className={styles.navItemIcon} />
              <span>Marketplace</span>
            </span>
            <span className={styles.navBadge}>L1</span>
          </button>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'sessions' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('sessions')}
          >
            <span className={styles.navItemLeft}>
              <IconLaptop size={16} className={styles.navItemIcon} />
              <span>Active Sessions</span>
            </span>
          </button>
        </div>

        {isOwner && <div className={styles.navGroup}>
          <div className={styles.groupHeader}>Publisher / Owner</div>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'owner' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('owner')}
          >
            <span className={styles.navItemLeft}>
              <IconBox size={16} className={styles.navItemIcon} />
              <span>Owner Console</span>
            </span>
            <span className={styles.navBadge} style={{ color: '#38bdf8' }}>Owner</span>
          </button>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'list-software' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('list-software')}
          >
            <span className={styles.navItemLeft}>
              <IconKey size={16} className={styles.navItemIcon} />
              <span>List Software</span>
            </span>
          </button>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'activity' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('activity')}
          >
            <span className={styles.navItemLeft}>
              <IconTerminal size={16} className={styles.navItemIcon} />
              <span>Rental Activity</span>
            </span>
          </button>
        </div>}

        <div className={styles.navGroup}>
          <div className={styles.groupHeader}>Platform Governance</div>
          <button
            type="button"
            className={`${styles.navItem} ${current === 'security' ? styles.navItemActive : ''}`}
            onClick={() => onNavigate('security')}
          >
            <span className={styles.navItemLeft}>
              <IconShield size={16} className={styles.navItemIcon} />
              <span>Security Posture</span>
            </span>
          </button>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.userCard}>
          <div className={styles.userMeta}>
            <div className={styles.userAvatar}>
              {isOwner ? 'O' : 'R'}
            </div>
            <div className={styles.userNameBlock}>
              <span className={styles.userName}>{userLabel}</span>
              <span className={styles.userRole}>{isOwner ? 'Publisher' : 'Member'}</span>
            </div>
          </div>
          {onSwitchUser ? (
            <button
              type="button"
              className={styles.navItemIcon}
              onClick={onSwitchUser}
              title="Switch demo role (Owner / Renter)"
              aria-label="Switch demo role"
              style={{ padding: 4 }}
            >
              <IconRefresh size={16} />
            </button>
          ) : onSignOut ? (
            <button
              type="button"
              className={styles.navItemIcon}
              onClick={onSignOut}
              title="Sign out"
              aria-label="Sign out"
              style={{ padding: 4 }}
            >
              <IconLogOut size={16} />
            </button>
          ) : null}
        </div>

      </div>
    </aside>
  );
}

