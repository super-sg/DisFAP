import { useCallback, useEffect, useState, type JSX } from 'react';
import type { ApiClient, OwnerListing } from '../api/client.js';
import { IconArrowRight, IconBox, IconCheck, IconLayers, IconLinux, IconLock, IconPlus, IconServer, IconShield, IconWindows } from '../ui/Icons.js';
import styles from './DashboardPage.module.css';

export interface DashboardPageProps {
  api: ApiClient;
  /** Owners see their listings; renters see a marketplace entry point. */
  isOwner: boolean;
  onNavigate: (page: 'workspaces') => void;
}

/**
 * Owner & Renter overview dashboard backed by the control plane.
 *
 * `GET /api/marketplace/licenses/mine` is scoped server-side to the
 * authenticated principal, so this page can only ever show the caller's own
 * listings and rentals.
 */
export function DashboardPage({ api, isOwner, onNavigate }: DashboardPageProps): JSX.Element {
  const [listings, setListings] = useState<OwnerListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isOwner) return;
    setError(null);
    try {
      setListings(await api.listMyLicenses());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load your listings');
      setListings(null);
    }
  }, [api, isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeRentals = listings?.filter((l) => l.activeRental !== null) ?? [];
  const available = listings?.filter((l) => l.status === 'available') ?? [];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.greeting}>{isOwner ? 'Publisher Operations Dashboard' : 'Workspace & Access Dashboard'}</h1>
        <p className={styles.greetingSub}>
          {isOwner
            ? 'Publish licensed software, oversee ephemeral instance allocations, and track active rentals.'
            : 'Explore federated software catalog, launch isolated workstations, and manage active sessions.'}
        </p>
      </header>

      {isOwner ? (
        <>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <span className={styles.statCardLabel}>My Listings</span>
              <span className={styles.statCardValue} data-accent="true">{listings?.length ?? '—'}</span>
              <span className={styles.statCardMeta}>
                <span className={styles.statDot} data-color="blue" aria-hidden="true" />
                Owner-scoped listings
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statCardLabel}>Available</span>
              <span className={styles.statCardValue}>{listings ? available.length : '—'}</span>
              <span className={styles.statCardMeta}>
                <span className={styles.statDot} data-color="green" aria-hidden="true" />
                Ready to rent
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statCardLabel}>Active Rentals</span>
              <span className={styles.statCardValue}>{listings ? activeRentals.length : '—'}</span>
              <span className={styles.statCardMeta}>
                <span className={styles.statDot} data-color="amber" aria-hidden="true" />
                Open rental records
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statCardLabel}>Credential Path</span>
              <span className={styles.statCardValue} style={{ fontSize: '1.15rem' }}>RSA + Vault (Software)</span>
              <span className={styles.statCardMeta}>
                <span className={styles.statDot} data-color="green" aria-hidden="true" />
                Never sent to renters
              </span>
            </div>
          </div>

          <div className={styles.columns}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className={styles.panelTitle}>My Software Listings</h2>
                <span className={styles.panelBadge}>{listings?.length ?? '—'}</span>
              </div>

              {error && (
                <div role="alert" style={{ padding: '1rem 1.25rem', color: 'var(--dfap-danger)' }}>
                  {error}
                  <button type="button" onClick={() => void load()} style={{ marginLeft: '0.75rem' }}>
                    Retry
                  </button>
                </div>
              )}
              {listings === null && !error && (
                <div className={styles.sessionMeta} style={{ padding: '1.25rem' }}>
                  Loading software inventory…
                </div>
              )}
              {listings?.length === 0 && !error && (
                <div className={styles.sessionMeta} style={{ padding: '1.5rem', textAlign: 'center' }}>
                  No listings published yet. Select "List a new workspace" to publish your first application.
                </div>
              )}
              {listings?.map((lic) => (
                <div key={lic.id} className={styles.sessionRow}>
                  <div className={styles.sessionIcon} data-os={lic.os} aria-hidden="true">
                    {lic.os === 'windows' ? <IconWindows size={16} /> : <IconLinux size={16} />}
                  </div>
                  <div className={styles.sessionInfo}>
                    <div className={styles.sessionName}>
                      {lic.softwareName} <span className={styles.sessionMeta}>v{lic.version}</span>
                    </div>
                    <div className={styles.sessionMeta}>
                      ${lic.hourlyRateUsd.toFixed(2)}/hr ·{' '}
                      {lic.maxDurationHours
                        ? `up to ${lic.maxDurationHours}h`
                        : 'renter selects duration'}{' '}
                      · {lic.category}
                    </div>
                    <div className={styles.sessionMeta}>
                      {lic.activeRental
                        ? `Rented by ${lic.activeRental.renteeId} · ${lic.activeRental.hoursRequested}h · session ${lic.activeRental.sessionId}`
                        : 'No active rental'}
                    </div>
                  </div>
                  <span
                    className={styles.stateBadge}
                    data-state={lic.activeRental ? 'connected' : lic.status}
                  >
                    {lic.activeRental ? 'rented' : lic.status}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2 className={styles.panelTitle}>Add Software</h2>
                </div>
                <div
                  className={styles.quickCard}
                  onClick={() => onNavigate('workspaces')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onNavigate('workspaces');
                  }}
                >
                  <div className={styles.quickIcon} aria-hidden="true">
                    <IconPlus size={18} />
                  </div>
                  <div className={styles.quickInfo}>
                    <div className={styles.quickName}>List a new workspace</div>
                    <div className={styles.quickMeta}>Open Workspaces → List Software (Owner)</div>
                  </div>
                  <span className={styles.quickArrow} aria-hidden="true">→</span>
                </div>
                <p className={styles.sessionMeta} style={{ padding: '0.875rem 1.25rem 1rem' }}>
                  The demo credential is encrypted via RSA before storage and is never returned to any
                  browser.
                </p>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2 className={styles.panelTitle}>Isolation Checklist</h2>
                </div>
                <div className={styles.statusGrid}>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Listing State</span>
                    <span className={styles.statusValue}>
                      <span className={styles.statusValueDot} aria-hidden="true" />
                      {listings === null ? 'Not loaded' : available.length > 0 ? `${available.length} Available` : 'Add one'}
                    </span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Active Lease</span>
                    <span className={styles.statusValue}>
                      <span className={styles.statusValueDot} aria-hidden="true" />
                      {listings === null ? 'Not loaded' : activeRentals.length > 0 ? `${activeRentals.length} Open` : 'None open'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className={styles.columns}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Renter Access Gateway</h2>
            </div>
            <div
              className={styles.quickCard}
              onClick={() => onNavigate('workspaces')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onNavigate('workspaces');
              }}
            >
              <div className={styles.quickIcon} aria-hidden="true">
                <IconLayers size={18} />
              </div>
              <div className={styles.quickInfo}>
                <div className={styles.quickName}>Browse the software marketplace</div>
                <div className={styles.quickMeta}>Pick a published listing and click Use Software</div>
              </div>
              <span className={styles.quickArrow} aria-hidden="true">→</span>
            </div>
            <p className={styles.sessionMeta} style={{ padding: '1rem 1.25rem' }}>
              All applications stream as isolated pixels via Guacamole over encrypted WebSockets. Your browser executes zero third-party binaries.
            </p>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
                <h2 className={styles.panelTitle}>Session controls</h2>
            </div>
            <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8125rem', color: '#cbd5e1' }}>
                <IconCheck size={16} style={{ color: '#10b981' }} />
                <span>Pixel-only isolation (No file or clipboard bridging)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8125rem', color: '#cbd5e1' }}>
                <IconCheck size={16} style={{ color: '#10b981' }} />
                <span>Single-use 60s dynamic connect capabilities</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8125rem', color: '#10b981' }}>
                <IconCheck size={16} style={{ color: '#10b981' }} />
                <span>Worker termination requested at session end, with reaper recovery</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
