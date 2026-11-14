import type { JSX, ReactNode } from 'react';
import { Sidebar, type NavPage } from './Sidebar.js';
import { TopBar } from './TopBar.js';
import styles from './ApplicationShell.module.css';

export interface ApplicationShellProps {
  current: NavPage;
  onNavigate: (page: NavPage) => void;
  isOwner?: boolean;
  userLabel?: string;
  onSignOut?: () => void;
  onSwitchUser?: () => void;
  children: ReactNode;
}

export function ApplicationShell({
  current,
  onNavigate,
  isOwner,
  userLabel,
  onSignOut,
  onSwitchUser,
  children,
}: ApplicationShellProps): JSX.Element {
  return (
    <div className={styles.shell}>
      <Sidebar
        current={current}
        onNavigate={onNavigate}
        isOwner={isOwner ?? false}
        {...(userLabel ? { userLabel } : {})}
        {...(onSignOut ? { onSignOut } : {})}
        {...(onSwitchUser ? { onSwitchUser } : {})}
      />
      <div className={styles.mainArea}>
        <TopBar
          current={current}
          onNavigate={onNavigate}
          {...(userLabel ? { userLabel } : {})}
          {...(onSignOut ? { onSignOut } : {})}
          {...(onSwitchUser ? { onSwitchUser } : {})}
        />
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}

