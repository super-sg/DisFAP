import type { JSX } from 'react';
import styles from './DashboardPage.module.css';

export interface DashboardPageProps {
  onNavigate: (page: 'workspaces') => void;
}

/* ─ Mock data for Phase-0 demo (no list-sessions API endpoint yet) ──── */
const RECENT_SESSIONS = [
  { id: 's1', name: 'Audit Workstation', os: 'windows' as const, state: 'connected', time: '2 min ago', user: 'sarah.k' },
  { id: 's2', name: 'Dev Environment', os: 'linux' as const, state: 'ended', time: '1h ago', user: 'mike.r' },
  { id: 's3', name: 'Finance Review', os: 'windows' as const, state: 'ended', time: '3h ago', user: 'alice.p' },
  { id: 's4', name: 'Contractor Access', os: 'linux' as const, state: 'allocating', time: 'just now', user: 'contractor-3' },
  { id: 's5', name: 'Security Review', os: 'windows' as const, state: 'failed', time: '5h ago', user: 'bob.j' },
] as const;

const QUICK_LAUNCH = [
  { id: 't1', name: 'Audit Workstation', os: 'windows' as const, desc: 'Pre-configured for SOC 2 audit' },
  { id: 't2', name: 'Dev Environment', os: 'linux' as const, desc: 'Ubuntu 24.04 with dev tooling' },
  { id: 't3', name: 'Finance Review', os: 'windows' as const, desc: 'Locked-down finance stack' },
] as const;

const OS_ICON: Record<'windows' | 'linux', string> = {
  windows: '⊞',
  linux: '🐧',
};

export function DashboardPage({ onNavigate }: DashboardPageProps): JSX.Element {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.greeting}>Dashboard</h1>
        <p className={styles.greetingSub}>
          System overview and recent session activity.
        </p>
      </header>

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <span className={styles.statCardLabel}>Active Sessions</span>
          <span className={styles.statCardValue} data-accent="true">2</span>
          <span className={styles.statCardMeta}>
            <span className={styles.statDot} data-color="green" aria-hidden="true" />
            All healthy
          </span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statCardLabel}>Today's Hours</span>
          <span className={styles.statCardValue}>14.2</span>
          <span className={styles.statCardMeta}>
            <span className={styles.statDot} data-color="blue" aria-hidden="true" />
            Across 8 sessions
          </span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statCardLabel}>Pool Ready</span>
          <span className={styles.statCardValue}>3</span>
          <span className={styles.statCardMeta}>
            <span className={styles.statDot} data-color="green" aria-hidden="true" />
            Warm VMs available
          </span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statCardLabel}>Security Events</span>
          <span className={styles.statCardValue}>0</span>
          <span className={styles.statCardMeta}>
            <span className={styles.statDot} data-color="green" aria-hidden="true" />
            No filter violations today
          </span>
        </div>
      </div>

      {/* ── Two-column: Recent Sessions + Quick Launch ──────────────────── */}
      <div className={styles.columns}>
        {/* Recent sessions */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Recent Sessions</h2>
            <span className={styles.panelBadge}>{RECENT_SESSIONS.length}</span>
          </div>
          {RECENT_SESSIONS.map((s) => (
            <div key={s.id} className={styles.sessionRow}>
              <div className={styles.sessionIcon} data-os={s.os} aria-hidden="true">
                {OS_ICON[s.os]}
              </div>
              <div className={styles.sessionInfo}>
                <div className={styles.sessionName}>{s.name}</div>
                <div className={styles.sessionMeta}>{s.user} · {s.time}</div>
              </div>
              <span className={styles.stateBadge} data-state={s.state}>{s.state}</span>
            </div>
          ))}
        </div>

        {/* Right column: Quick launch + System status */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Quick Launch</h2>
            </div>
            {QUICK_LAUNCH.map((t) => (
              <div
                key={t.id}
                className={styles.quickCard}
                onClick={() => onNavigate('workspaces')}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onNavigate('workspaces'); }}
              >
                <div className={styles.quickIcon} aria-hidden="true">{OS_ICON[t.os]}</div>
                <div className={styles.quickInfo}>
                  <div className={styles.quickName}>{t.name}</div>
                  <div className={styles.quickMeta}>{t.desc}</div>
                </div>
                <span className={styles.quickArrow} aria-hidden="true">→</span>
              </div>
            ))}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>System Status</h2>
            </div>
            <div className={styles.statusGrid}>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>API</span>
                <span className={styles.statusValue}>
                  <span className={styles.statusValueDot} aria-hidden="true" />
                  Healthy
                </span>
              </div>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Broker</span>
                <span className={styles.statusValue}>
                  <span className={styles.statusValueDot} aria-hidden="true" />
                  Healthy
                </span>
              </div>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Vault</span>
                <span className={styles.statusValue}>
                  <span className={styles.statusValueDot} aria-hidden="true" />
                  Sealed
                </span>
              </div>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Reaper</span>
                <span className={styles.statusValue}>
                  <span className={styles.statusValueDot} aria-hidden="true" />
                  Running
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
