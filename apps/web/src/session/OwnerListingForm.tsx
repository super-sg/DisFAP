import { useState, type JSX } from 'react';

import type { ApiClient } from '../api/client.js';
import { RENTAL_HOUR_DURATIONS, demoPassword } from './launch-types.js';
import styles from './LaunchPage.module.css';

interface OwnerForm {
  softwareName: string;
  version: string;
  category: string;
  description: string;
  os: 'windows' | 'linux';
  hourlyRateUsd: number;
  maxDurationHours: number;
  username: string;
  password: string;
}

export interface OwnerListingFormProps {
  api: ApiClient;
  /** Called after a listing is created so the caller can refresh the catalog. */
  onPublished: (licenseId: string) => void | Promise<void>;
}

function initialForm(): OwnerForm {
  return {
    softwareName: 'Demo Workstation (XTuple-like)',
    version: '1.0',
    category: 'engineering',
    description:
      'Licensed demo desktop: XFCE with an interactive DisFAP demo application, streamed as isolated pixels.',
    os: 'linux',
    hourlyRateUsd: 2.5,
    maxDurationHours: 4,
    // The credential is DEDICATED and non-personal — generated here, never a
    // person's reusable password.
    username: 'dfapdemo',
    password: demoPassword(),
  };
}

/** Owner "List software" form (evaluation path). */
export function OwnerListingForm({ api, onPublished }: OwnerListingFormProps): JSX.Element {
  const [form, setForm] = useState<OwnerForm>(initialForm);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  const patch = <K extends keyof OwnerForm>(key: K, value: OwnerForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const publish = async (): Promise<void> => {
    setError(null);
    setPublished(null);
    setPublishing(true);
    try {
      const created = await api.createLicense({
        softwareName: form.softwareName,
        version: form.version,
        category: form.category,
        description: form.description,
        os: form.os,
        hourlyRateUsd: form.hourlyRateUsd,
        maxDurationHours: form.maxDurationHours,
        // Explicit declaration that this is a DEDICATED, throwaway demo
        // credential (never a person's reusable password). It is the only way
        // the evaluation path may install the credential on the disposable
        // session VM; a reusable credential is refused server-side.
        credentials: { username: form.username, password: form.password, demoOnly: true },
      });
      setPublished(created.id);
      // Drop the submitted plaintext from component state once it is sealed
      // server-side; the next publish gets a fresh throwaway credential.
      setForm((prev) => ({ ...prev, password: demoPassword() }));
      await onPublished(created.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to publish listing');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className={styles.ownerForm}>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-name">
          Application name
        </label>
        <input
          id="own-name"
          className={styles.fieldInput}
          value={form.softwareName}
          onChange={(e) => patch('softwareName', e.target.value)}
        />
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-version">
          Version
        </label>
        <input
          id="own-version"
          className={styles.fieldInput}
          value={form.version}
          onChange={(e) => patch('version', e.target.value)}
        />
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-category">
          Software category
        </label>
        <select
          id="own-category"
          className={styles.fieldSelect}
          value={form.category}
          onChange={(e) => patch('category', e.target.value)}
        >
          <option value="engineering">Engineering</option>
          <option value="design">Design</option>
          <option value="development">Development</option>
          <option value="data-science">Data science</option>
          <option value="productivity">Productivity</option>
        </select>
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-desc">
          Description
        </label>
        <input
          id="own-desc"
          className={styles.fieldInput}
          value={form.description}
          onChange={(e) => patch('description', e.target.value)}
        />
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-os">
          Operating system
        </label>
        <select
          id="own-os"
          className={styles.fieldSelect}
          value={form.os}
          onChange={(e) => patch('os', e.target.value as OwnerForm['os'])}
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
          value={form.hourlyRateUsd}
          onChange={(e) => patch('hourlyRateUsd', Number(e.target.value))}
        />
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-duration">
          Access duration
        </label>
        <select
          id="own-duration"
          className={styles.fieldSelect}
          value={form.maxDurationHours}
          onChange={(e) => patch('maxDurationHours', Number(e.target.value))}
        >
          {RENTAL_HOUR_DURATIONS.map((h) => (
            <option key={h} value={h}>
              Up to {h} hour{h > 1 ? 's' : ''} per rental
            </option>
          ))}
        </select>
        <span className={styles.fieldHelp}>
          The renter can choose any duration up to this maximum. The limit is enforced by the API before a VM
          is launched.
        </span>
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-user">
          Demo account username
        </label>
        <input
          id="own-user"
          className={styles.fieldInput}
          autoComplete="off"
          value={form.username}
          onChange={(e) => patch('username', e.target.value)}
        />
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="own-pass">
          Demo account password
        </label>
        <input
          id="own-pass"
          className={styles.fieldInput}
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => patch('password', e.target.value)}
        />
        <span className={styles.fieldHelp}>
          A single-purpose demo credential (auto-generated, masked). It is encrypted by the Layer&nbsp;2 RSA
          provider (software-backed) before storage, is never returned to any browser, and is installed only on
          the throwaway VM for this one listing.
        </span>
      </div>
      <button className={styles.startButton} onClick={() => void publish()} type="button" disabled={publishing}>
        {publishing ? 'Publishing…' : 'Publish Listing'}
      </button>
      {published && (
        <div className={styles.success} role="status">
          Published listing {published}. Switch to the Software Licenses tab to rent it.
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
