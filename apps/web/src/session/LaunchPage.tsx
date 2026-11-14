import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react';
import type { ApiClient, MarketplaceLicense, WorkspaceTemplate } from '../api/client.js';
import { IconBox, IconCheck, IconClock, IconKey, IconLayers, IconLinux, IconLock, IconSearch, IconServer, IconWindows } from '../ui/Icons.js';
import { LaunchProgress } from './LaunchProgress.js';
import { OwnerListingForm } from './OwnerListingForm.js';
import { RENTAL_HOUR_DURATIONS, type LaunchResult } from './launch-types.js';
import { useCatalog } from './useCatalog.js';
import { useSessionLaunch } from './useSessionLaunch.js';
import styles from './LaunchPage.module.css';

export type { LaunchResult };

export interface LaunchPageProps {
  api: ApiClient;
  /** Owners can publish; renters only see the marketplace and workstations. */
  isOwner?: boolean;
  initialTab?: Tab;
  onReady: (result: LaunchResult) => void;
}

type Tab = 'marketplace' | 'workspaces' | 'owner';

export function LaunchPage({ api, isOwner = true, initialTab = 'marketplace', onReady }: LaunchPageProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab === 'owner' && !isOwner ? 'marketplace' : initialTab);
  const [hours, setHours] = useState<number>(RENTAL_HOUR_DURATIONS[0]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');

  const { licenses, templates, loadError, refreshLicenses } = useCatalog(api);
  const { launching, serverState, elapsed, startError, startWorkspace, startRental } = useSessionLaunch(
    api,
    onReady,
  );

  const handlePublished = useCallback(async () => {
    await refreshLicenses();
  }, [refreshLicenses]);

  const filteredLicenses = useMemo(() => {
    if (!licenses) return [];
    return licenses.filter((lic) => {
      const matchCat = category === 'all' || lic.category.toLowerCase() === category.toLowerCase();
      const matchQuery =
        search.trim() === '' ||
        lic.softwareName.toLowerCase().includes(search.toLowerCase()) ||
        lic.description.toLowerCase().includes(search.toLowerCase()) ||
        lic.ownerName.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchQuery;
    });
  }, [licenses, category, search]);

  if (launching) {
    return <LaunchProgress launching={launching} serverState={serverState} elapsed={elapsed} />;
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          DisFAP <span className={styles.titleAccent}>Software Marketplace</span>
        </h1>
        <p className={styles.subtitle}>
          Zero-exposure software licensing: rent premium tools or launch ephemeral workstations streamed
          entirely as safe pixels.
        </p>
      </header>

      <nav className={styles.tabs} aria-label="Catalog views">
        <TabButton active={activeTab === 'marketplace'} onClick={() => setActiveTab('marketplace')}>
          <IconLayers size={16} />
          <span>Software licenses</span>
        </TabButton>
        <TabButton active={activeTab === 'workspaces'} onClick={() => setActiveTab('workspaces')}>
          <IconServer size={16} />
          <span>Base workspaces</span>
        </TabButton>
        {isOwner && (
          <TabButton active={activeTab === 'owner'} onClick={() => setActiveTab('owner')}>
            <IconKey size={16} />
            <span>List software</span>
          </TabButton>
        )}
      </nav>

      {startError && (
        <div className={styles.error} role="alert">
          {startError}
        </div>
      )}

      {activeTab === 'marketplace' && (
        <>
          <div className={styles.filterBar}>
            <div className={styles.searchWrap}>
              <IconSearch size={16} className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Search software catalog by name, category, or owner..."
                className={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className={styles.categoryGroup} role="toolbar" aria-label="Category filters">
              {['all', 'engineering', 'design', 'development', 'productivity'].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`${styles.categoryChip} ${category === cat ? styles.categoryChipActive : ''}`}
                  onClick={() => setCategory(cat)}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>

            <div className={styles.durationRow}>
              <label className={styles.durationLabel} htmlFor="rent-hours">
                Rental duration:
              </label>
              <select
                id="rent-hours"
                className={styles.durationSelect}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                {RENTAL_HOUR_DURATIONS.map((h) => (
                  <option key={h} value={h}>
                    {h} hour{h > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <LicenseGrid
            licenses={licenses === null ? null : filteredLicenses}
            loadError={loadError}
            hours={hours}
            onRent={startRental}
          />
        </>
      )}

      {activeTab === 'workspaces' && <WorkspaceGrid templates={templates} onStart={startWorkspace} />}

      {activeTab === 'owner' && isOwner && (
        <OwnerListingForm api={api} onPublished={handlePublished} />
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ''}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function LicenseGrid({
  licenses,
  loadError,
  hours,
  onRent,
}: {
  licenses: MarketplaceLicense[] | null;
  loadError: string | null;
  hours: number;
  onRent: (license: MarketplaceLicense, hours: number) => Promise<void>;
}): JSX.Element {
  if (loadError) return <div className={styles.error} role="alert">{loadError}</div>;
  if (licenses === null) return <p className={styles.muted}>Loading marketplace software listings…</p>;
  if (licenses.length === 0)
    return <p className={styles.muted}>No software licenses match the filter criteria.</p>;

  return (
    <ul className={styles.templateGrid}>
      {licenses.map((lic) => (
        <li key={lic.id} className={styles.templateCard}>
          <div className={styles.templateHead}>
            <div className={styles.osIcon} data-os={lic.os} aria-hidden="true">
              {lic.os === 'windows' ? <IconWindows size={18} /> : <IconLinux size={18} />}
            </div>
            <div className={styles.templateHeadInfo}>
              <h3 className={styles.templateTitle}>
                {lic.softwareName}
              </h3>
              <div className={styles.templateMetaRow}>
                <span className={styles.osBadge}>{lic.os.toUpperCase()}</span>
                <span style={{ color: '#64748b' }}>•</span>
                <span className={styles.priceTag}>${lic.hourlyRateUsd.toFixed(2)}/hr</span>
              </div>
            </div>
          </div>

          <p className={styles.templateDesc}>{lic.description}</p>

          <div className={styles.cardDetails}>
            <div className={styles.cardDetailItem}>
              <span>Owner: {lic.ownerName}</span>
              <span>Category: {lic.category}</span>
            </div>
            <div className={styles.cardDetailItem}>
              <span>
                {lic.maxDurationHours
                  ? `Access: up to ${lic.maxDurationHours} hour${lic.maxDurationHours > 1 ? 's' : ''}`
                  : 'Access: renter selects duration'}
              </span>
              <span data-available={lic.status === 'available'}>
                {lic.status === 'available' ? 'Available now' : lic.status}
              </span>
            </div>
          </div>

          <div className={styles.hsmBadge}>
            <span>RSA-OAEP protected · software key</span>
          </div>

          {lic.maxDurationHours !== null && lic.maxDurationHours !== undefined && hours > lic.maxDurationHours && (
            <p className={styles.recordingNote} role="status">
              Selected duration exceeds this listing’s {lic.maxDurationHours}h limit.
            </p>
          )}
          <button
            className={styles.startButton}
            onClick={() => void onRent(lic, hours)}
            type="button"
            disabled={lic.status !== 'available' || (lic.maxDurationHours != null && hours > lic.maxDurationHours)}
          >
            Use Software ({hours}h · ${(lic.hourlyRateUsd * hours).toFixed(2)}) →
          </button>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceGrid({
  templates,
  onStart,
}: {
  templates: WorkspaceTemplate[] | null;
  onStart: (template: WorkspaceTemplate) => Promise<void>;
}): JSX.Element {
  if (templates === null) return <p className={styles.muted}>Loading base workstations…</p>;
  if (templates.length === 0)
    return <p className={styles.muted}>No workspace templates are available for your account.</p>;

  return (
    <ul className={styles.templateGrid}>
      {templates.map((t) => (
        <li key={t.id} className={styles.templateCard}>
          <div className={styles.templateHead}>
            <div className={styles.osIcon} data-os={t.os} aria-hidden="true">
              {t.os === 'windows' ? <IconWindows size={18} /> : <IconLinux size={18} />}
            </div>
            <div className={styles.templateHeadInfo}>
              <h3 className={styles.templateTitle}>{t.name}</h3>
              <div className={styles.templateMetaRow}>
                <span className={styles.osBadge}>{t.os.toUpperCase()}</span>
                <span style={{ color: '#64748b' }}>•</span>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Base VM</span>
              </div>
            </div>
          </div>

          {t.description && <p className={styles.templateDesc}>{t.description}</p>}

          {t.recording && (
            <p className={styles.recordingNote} title="Capture and retention require deployment verification.">
              Recording configured
            </p>
          )}

          <button className={styles.startButton} onClick={() => void onStart(t)} type="button">
            Start session →
          </button>
        </li>
      ))}
    </ul>
  );
}
