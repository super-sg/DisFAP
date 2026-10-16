import { useEffect, useState, type JSX } from 'react';
import {
  ApiClient,
  ApiError,
  isConnectable,
  isTerminal,
  type ConnectCredentials,
  type MarketplaceLicense,
  type SessionInfo,
  type WorkspaceTemplate,
} from '../api/client.js';
import { ProgressSteps } from './Progress.js';
import styles from './LaunchPage.module.css';

/** Session context handed up once the workspace is connectable. */
export interface LaunchResult {
  session: SessionInfo;
  template: WorkspaceTemplate;
  connect: ConnectCredentials;
}

export interface LaunchPageProps {
  api: ApiClient;
  onReady: (result: LaunchResult) => void;
}

/** Poll cadence and overall budget for the (slow) cold start. */
const POLL_INTERVAL_MS = 2500;
// A real AWS cold start boots a stock image and installs its desktop, so allow
// a generous budget; the server only reports `ready` once the guest is really up.
const COLD_START_BUDGET_MS = 600_000; // 10 min

/** A dedicated, non-personal demo credential for the licensed app. */
function demoPassword(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `Dfap-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface OwnerForm {
  softwareName: string;
  version: string;
  category: string;
  description: string;
  os: 'windows' | 'linux';
  hourlyRateUsd: number;
  username: string;
  password: string;
}

interface Launching {
  sessionId: string;
  template: WorkspaceTemplate;
  telemetry?: {
    thread1VmSpoolingMs: number;
    thread2CredentialRetrievalMs: number;
    orchestratorTotalMs: number;
    hsmKeyFingerprint: string;
  };
}

const OS_ICON: Record<string, string> = {
  windows: '⊞',
  linux: '🐧',
};

export function LaunchPage({ api, onReady }: LaunchPageProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<'marketplace' | 'workspaces' | 'owner'>('marketplace');
  const [templates, setTemplates] = useState<WorkspaceTemplate[] | null>(null);
  const [licenses, setLicenses] = useState<MarketplaceLicense[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<Launching | null>(null);
  const [hours, setHours] = useState(1);
  const [serverState, setServerState] = useState<SessionInfo['state']>('requested');
  const [elapsed, setElapsed] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);

  // Owner "List software" form (evaluation). The credential is DEDICATED and
  // non-personal — generated here, never a person's reusable password.
  const [ownerForm, setOwnerForm] = useState<OwnerForm>(() => ({
    softwareName: 'Demo Workstation (XTuple-like)',
    version: '1.0',
    category: 'engineering',
    description: 'Licensed demo desktop: XFCE desktop with a demo application, streamed as isolated pixels.',
    os: 'linux',
    hourlyRateUsd: 2.5,
    username: 'dfapdemo',
    password: demoPassword(),
  }));
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  // Load both the marketplace licenses and template list.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listLicenses().catch(() => []),
      api.listTemplates().catch(() => []),
    ])
      .then(([lics, tmpls]) => {
        if (!cancelled) {
          setLicenses(lics);
          setTemplates(tmpls);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load catalog');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Drive the allocation poll loop once a session is starting.
  useEffect(() => {
    if (!launching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));

      if (Date.now() - startedAt > COLD_START_BUDGET_MS) {
        setStartError('Timed out waiting for the workspace to become ready.');
        setLaunching(null);
        return;
      }

      try {
        const info = await api.getSession(launching.sessionId);
        if (cancelled) return;
        setServerState(info.state);

        if (isConnectable(info.state) && info.connect) {
          // Hand off with the *freshest* handle (getSession re-mints it).
          onReady({ session: info, template: launching.template, connect: info.connect });
          return;
        }
        if (isTerminal(info.state)) {
          setStartError(info.endReason ?? `Workspace ended before it was ready (${info.state}).`);
          setLaunching(null);
          return;
        }
      } catch (err: unknown) {
        if (cancelled) return;
        // Transient control-plane hiccups during a long cold start shouldn't
        // kill the launch; only a hard 4xx (bad session) is fatal.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          setStartError(err.message);
          setLaunching(null);
          return;
        }
        // otherwise fall through and retry on the next tick
      }

      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [launching, api, onReady]);

  const handleStart = async (template: WorkspaceTemplate): Promise<void> => {
    setStartError(null);
    setElapsed(0);
    setServerState('requested');
    try {
      const started = await api.startSession(template.id);
      setLaunching({ sessionId: started.sessionId, template });
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : 'Failed to start session');
    }
  };

  const handleRent = async (license: MarketplaceLicense, hoursRequested: number): Promise<void> => {
    setStartError(null);
    setElapsed(0);
    setServerState('requested');
    try {
      const result = await api.rentLicense(license.id, hoursRequested);
      const syntheticTemplate: WorkspaceTemplate = {
        id: license.id,
        name: `${license.softwareName} (${license.version})`,
        description: license.description,
        os: license.os,
        recording: true,
      };
      setLaunching({
        sessionId: result.sessionId,
        template: syntheticTemplate,
        telemetry: result.telemetry,
      });
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : 'Failed to rent software license');
    }
  };

  const handlePublish = async (): Promise<void> => {
    setPublishError(null);
    setPublished(null);
    setPublishing(true);
    try {
      const created = await api.createLicense({
        softwareName: ownerForm.softwareName,
        version: ownerForm.version,
        category: ownerForm.category,
        description: ownerForm.description,
        os: ownerForm.os,
        hourlyRateUsd: ownerForm.hourlyRateUsd,
        credentials: { username: ownerForm.username, password: ownerForm.password },
      });
      setPublished(created.id);
      const lics = await api.listLicenses().catch(() => []);
      setLicenses(lics);
      setActiveTab('marketplace');
    } catch (err: unknown) {
      setPublishError(err instanceof Error ? err.message : 'Failed to publish listing');
    } finally {
      setPublishing(false);
    }
  };

  if (launching) {
    const phaseIndex = serverState === 'requested' ? 0 : isConnectable(serverState) ? 2 : 1;
    return (
      <main className={styles.page}>
        <section className={styles.progressCard} aria-live="polite">
          <h1 className={styles.progressTitle}>Launching {launching.template.name}</h1>
          <ProgressSteps currentIndex={phaseIndex} elapsedSeconds={elapsed} />

          {launching.telemetry && (
            <div className={styles.telemetryBox}>
              <div className={styles.telemetryTitle}>⚡ Layer 3 Two-Thread Orchestration Telemetry</div>
              <div className={styles.telemetryRow}>
                <span>Thread 1 (VM Spooling):</span>
                <span>{launching.telemetry.thread1VmSpoolingMs} ms</span>
              </div>
              <div className={styles.telemetryRow}>
                <span>Thread 2 (HSM Decrypt & Stage):</span>
                <span>{launching.telemetry.thread2CredentialRetrievalMs} ms</span>
              </div>
              <div className={styles.telemetryRow}>
                <span>Parallel Orchestrator Total:</span>
                <span>{launching.telemetry.orchestratorTotalMs} ms</span>
              </div>
              <div className={styles.telemetryRow}>
                <span>HSM RSA-4096 Key:</span>
                <span>{launching.telemetry.hsmKeyFingerprint}</span>
              </div>
            </div>
          )}

          {launching.template.recording && (
            <p className={styles.recordingNote}>
              <span className={styles.recDot} aria-hidden="true" />
              This workspace is pixel-isolated and recorded for audit
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          DisFAP <span className={styles.titleAccent}>Software Marketplace</span>
        </h1>
        <p className={styles.subtitle}>
          Zero-exposure software licensing: rent premium tools or launch ephemeral workstations streamed entirely as safe pixels.
        </p>
      </header>

      <nav className={styles.tabs} aria-label="Catalog views">
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'marketplace' ? styles.tabBtnActive : ''}`}
          onClick={() => setActiveTab('marketplace')}
        >
          💎 Software Licenses (Layer 1)
        </button>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'workspaces' ? styles.tabBtnActive : ''}`}
          onClick={() => setActiveTab('workspaces')}
        >
          🖥️ Base DevBoxes
        </button>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'owner' ? styles.tabBtnActive : ''}`}
          onClick={() => setActiveTab('owner')}
        >
          🏷️ List Software (Owner)
        </button>
      </nav>

      {startError && (
        <div className={styles.error} role="alert">
          {startError}
        </div>
      )}

      {activeTab === 'marketplace' && (
        <div className={styles.durationRow}>
          <label className={styles.durationLabel} htmlFor="rent-hours">
            Rental duration
          </label>
          <select
            id="rent-hours"
            className={styles.durationSelect}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {[1, 2, 4, 8].map((h) => (
              <option key={h} value={h}>
                {h} hour{h > 1 ? 's' : ''}
              </option>
            ))}
          </select>
          <span className={styles.durationHint}>
            Billed per hour — access is revoked the instant the session ends.
          </span>
        </div>
      )}

      {loadError ? (
        <div className={styles.error} role="alert">
          {loadError}
        </div>
      ) : activeTab === 'marketplace' ? (
        licenses === null ? (
          <p className={styles.muted}>Loading software catalog…</p>
        ) : licenses.length === 0 ? (
          <p className={styles.muted}>No software licenses are currently listed.</p>
        ) : (
          <ul className={styles.templateGrid}>
            {licenses.map((lic) => (
              <li key={lic.id} className={styles.templateCard}>
                <div className={styles.templateHead}>
                  <div className={styles.osIcon} aria-hidden="true">
                    {OS_ICON[lic.os] ?? '💻'}
                  </div>
                  <div className={styles.templateNameGroup}>
                    <h2 className={styles.templateName}>{lic.softwareName}</h2>
                    <span className={styles.osBadge} data-os={lic.os}>
                      {lic.os}
                    </span>
                  </div>
                  <span className={styles.priceTag}>${lic.hourlyRateUsd.toFixed(2)}/hr</span>
                </div>
                <p className={styles.templateDesc}>{lic.description}</p>
                <div className={styles.hsmBadge}>
                  <span>🔒 HSM RSA-4096 Protected</span>
                </div>
                <button
                  className={styles.startButton}
                  onClick={() => void handleRent(lic, hours)}
                  type="button"
                >
                  Rent &amp; Launch ({hours}h · ${(lic.hourlyRateUsd * hours).toFixed(2)}) →
                </button>
              </li>
            ))}
          </ul>
        )
      ) : activeTab === 'workspaces' ? (
        templates === null ? (
          <p className={styles.muted}>Loading workspaces…</p>
        ) : templates.length === 0 ? (
          <p className={styles.muted}>No workspaces are available for your account.</p>
        ) : (
          <ul className={styles.templateGrid}>
            {templates.map((t) => (
              <li key={t.id} className={styles.templateCard}>
                <div className={styles.templateHead}>
                  <div className={styles.osIcon} aria-hidden="true">
                    {OS_ICON[t.os] ?? '💻'}
                  </div>
                  <div className={styles.templateNameGroup}>
                    <h2 className={styles.templateName}>{t.name}</h2>
                    <span className={styles.osBadge} data-os={t.os}>
                      {t.os}
                    </span>
                  </div>
                </div>
                {t.description && <p className={styles.templateDesc}>{t.description}</p>}
                {t.recording && (
                  <p className={styles.recordingNote}>
                    <span className={styles.recDot} aria-hidden="true" /> Recorded for audit
                  </p>
                )}
                <button className={styles.startButton} onClick={() => void handleStart(t)} type="button">
                  Start session →
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className={styles.ownerForm}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-name">
              Application name
            </label>
            <input
              id="own-name"
              className={styles.fieldInput}
              value={ownerForm.softwareName}
              onChange={(e) => setOwnerForm({ ...ownerForm, softwareName: e.target.value })}
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-version">
              Version
            </label>
            <input
              id="own-version"
              className={styles.fieldInput}
              value={ownerForm.version}
              onChange={(e) => setOwnerForm({ ...ownerForm, version: e.target.value })}
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-desc">
              Description
            </label>
            <input
              id="own-desc"
              className={styles.fieldInput}
              value={ownerForm.description}
              onChange={(e) => setOwnerForm({ ...ownerForm, description: e.target.value })}
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-os">
              Operating system
            </label>
            <select
              id="own-os"
              className={styles.fieldSelect}
              value={ownerForm.os}
              onChange={(e) => setOwnerForm({ ...ownerForm, os: e.target.value as 'windows' | 'linux' })}
            >
              <option value="linux">linux</option>
              <option value="windows">windows</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-rate">
              Hourly rate (USD)
            </label>
            <input
              id="own-rate"
              type="number"
              min={0}
              step={0.5}
              className={styles.fieldInput}
              value={ownerForm.hourlyRateUsd}
              onChange={(e) => setOwnerForm({ ...ownerForm, hourlyRateUsd: Number(e.target.value) })}
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-user">
              Licensed app username
            </label>
            <input
              id="own-user"
              className={styles.fieldInput}
              value={ownerForm.username}
              onChange={(e) => setOwnerForm({ ...ownerForm, username: e.target.value })}
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="own-pass">
              Dedicated demo password
            </label>
            <input
              id="own-pass"
              className={styles.fieldInput}
              value={ownerForm.password}
              onChange={(e) => setOwnerForm({ ...ownerForm, password: e.target.value })}
            />
            <span className={styles.fieldHelp}>
              A single-purpose demo credential (auto-generated). It is encrypted by the Layer&nbsp;2 HSM
              before storage and never returned to the browser. For the local evaluation it is also
              installed on the throwaway VM for this one listing.
            </span>
          </div>
          <button
            className={styles.startButton}
            onClick={() => void handlePublish()}
            type="button"
            disabled={publishing}
          >
            {publishing ? 'Publishing…' : 'Publish listing →'}
          </button>
          {published && (
            <div className={styles.success} role="status">
              Published listing {published}. Switch to the Software Licenses tab to rent it.
            </div>
          )}
          {publishError && (
            <div className={styles.error} role="alert">
              {publishError}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
