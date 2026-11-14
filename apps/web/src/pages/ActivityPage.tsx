import { useEffect, useState, type JSX } from 'react';
import type { ApiClient, OwnerListing } from '../api/client.js';
import { Badge } from '../ui/Badge.js';
import { EmptyState } from '../ui/EmptyState.js';
import { IconActivity, IconRefresh } from '../ui/Icons.js';
import uiStyles from '../ui/ui.module.css';
import styles from './ActivityPage.module.css';

export interface ActivityPageProps {
  api: ApiClient;
  isOwner: boolean;
}

export function ActivityPage({ api, isOwner }: ActivityPageProps): JSX.Element {
  const [listings, setListings] = useState<OwnerListing[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listMyLicenses();
        if (!cancelled) {
          setListings(res);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load rental activity.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isOwner, reloadKey]);

  const rentals = (listings ?? [])
    .filter((l) => l.activeRental !== null)
    .map((l) => ({
      softwareName: l.softwareName,
      category: l.category,
      ...l.activeRental!,
    }));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Open Rental Activity</h1>
        <p className={styles.subtitle}>
          Current rentals for your published listings. Ended rental history is not exposed by the current API.
        </p>
      </header>

      {!isOwner ? (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="Rental activity is owner-scoped"
          description="This view lists current rentals for your published software. Renter session history is not available through the current API."
        />
      ) : error ? (
        <div role="alert" className={styles.errorState}>
          <p>{error}</p>
          <button type="button" onClick={() => { setLoading(true); setReloadKey((key) => key + 1); }}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <div style={{ padding: '2rem', color: '#64748b' }}>Loading rental activity...</div>
      ) : rentals.length > 0 ? (
        <div className={styles.tableContainer}>
          <div className={uiStyles.tableWrap}>
            <table className={uiStyles.table}>
              <thead>
                <tr>
                  <th className={uiStyles.tableTh}>Software Application</th>
                  <th className={uiStyles.tableTh}>Rentee Identity</th>
                  <th className={uiStyles.tableTh}>Session Linkage</th>
                  <th className={uiStyles.tableTh}>Requested</th>
                  <th className={uiStyles.tableTh}>Rental amount (USD)</th>
                  <th className={uiStyles.tableTh}>Started Timestamp</th>
                  <th className={uiStyles.tableTh}>State</th>
                </tr>
              </thead>
              <tbody>
                {rentals.map((r) => (
                  <tr key={r.id} className={uiStyles.tableTr}>
                    <td className={uiStyles.tableTd} style={{ fontWeight: 600 }}>
                      {r.softwareName}
                    </td>
                    <td className={`${uiStyles.tableTd} ${styles.mono}`}>
                      {r.renteeId}
                    </td>
                    <td className={`${uiStyles.tableTd} ${styles.mono}`}>
                      {r.sessionId}
                    </td>
                    <td className={uiStyles.tableTd}>
                      {r.hoursRequested}h
                    </td>
                    <td className={`${uiStyles.tableTd} ${styles.mono}`} style={{ color: '#38bdf8' }}>
                      ${r.totalChargedUsd.toFixed(2)}
                    </td>
                    <td className={`${uiStyles.tableTd} ${styles.mono}`}>
                      {new Date(r.startedAt).toLocaleString()}
                    </td>
                    <td className={uiStyles.tableTd}>
                      <Badge variant="warning" dot>
                        Open rental
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="No open rentals"
          description={
            isOwner
              ? "None of your published software is currently leased by renters. When a renter selects 'Use Software', their access session will be recorded here."
              : "No active software leases found for your account."
          }
        />
      )}
    </div>
  );
}

