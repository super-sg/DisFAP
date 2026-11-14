import type { JSX } from 'react';
import { BrandMark } from '../ui/BrandMark.js';
import { IconShield } from '../ui/Icons.js';
import styles from './DemoIdentityGate.module.css';

/** Local-evaluation principals. These exist only in the dev-header adapter. */
export const DEMO_IDENTITIES = {
  owner: {
    userId: 'usr_owner',
    orgId: 'org_dev',
    label: 'Alex Owner',
    role: 'owner',
    detail: 'Publish software listings, stage credentials, and oversee rentals',
    scopes: 'marketplace:publish, rentals:manage, sessions:view',
  },
  renter: {
    userId: 'usr_renter',
    orgId: 'org_dev',
    label: 'Riley Renter',
    role: 'member',
    detail: 'Browse catalog, rent remote software, and stream interactive desktop',
    scopes: 'marketplace:read, sessions:launch, sessions:terminate',
  },
} as const;

export type DemoRole = keyof typeof DEMO_IDENTITIES;

/** Read the requested local identity from `?as=owner|renter`. */
export function demoRoleFromSearch(search: string): DemoRole | null {
  const value = new URLSearchParams(search).get('as');
  return value === 'owner' || value === 'renter' ? value : null;
}

/** The dev identity gate is valid only for loopback development. */
export function demoAuthEnabled(env: { DEV: boolean }, location: Pick<Location, 'hostname'>): boolean {
  return env.DEV && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

export interface DemoIdentityGateProps {
  onSelect: (role: DemoRole) => void;
}

/**
 * Local-only stand-in for the two-person sign-in step. It is never rendered in
 * a production build (`demoAuthEnabled` requires `import.meta.env.DEV`), and it
 * selects an identity only for the server's dev-header authenticator. It does
 * not accept, store, or send a password.
 */
export function DemoIdentityGate({ onSelect }: DemoIdentityGateProps): JSX.Element {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-label="DisFAP Identity Console">
        <div className={styles.header}>
          <div className={styles.brandRow}>
            <BrandMark size={32} />
            <span className={styles.brandText}>
              Dis<span className={styles.brandAccent}>FAP</span>
            </span>
            <span className={styles.tag}>Zero-Trust Gate</span>
          </div>
          <h1 className={styles.title}>Federated Access Console</h1>
          <p className={styles.subtitle}>
            Select an evaluation identity for this session. Two separate browser contexts (e.g. standard and
            incognito) provide independent Publisher and Renter access with cryptographic isolation.
          </p>
        </div>

        <div className={styles.securityNote}>
          <IconShield size={18} style={{ color: '#38bdf8', flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Evaluation Security Policy:</strong> Loopback development mode strictly refuses client-sent roles.
            Privileges are bound server-side to the authenticated principal in PostgreSQL.
          </div>
        </div>

        <div className={styles.choices}>
          {(Object.entries(DEMO_IDENTITIES) as [DemoRole, (typeof DEMO_IDENTITIES)[DemoRole]][]).map(
            ([role, identity]) => (
              <button
                key={role}
                type="button"
                className={styles.choice}
                onClick={() => onSelect(role)}
                aria-label={`Select ${identity.label} (${identity.role})`}
              >
                <span className={styles.avatar} data-role={role} aria-hidden="true">
                  {role === 'owner' ? 'O' : 'R'}
                </span>
                <span className={styles.choiceBody}>
                  <div className={styles.choiceHeader}>
                    <span className={styles.choiceName}>{identity.label}</span>
                    <span className={styles.choiceRole}>{identity.role} · {identity.userId}</span>
                  </div>
                  <span className={styles.choiceDetail}>{identity.detail}</span>
                  <span className={styles.choiceScopes}>Scopes: {identity.scopes}</span>
                </span>
                <span className={styles.arrow} aria-hidden="true">→</span>
              </button>
            ),
          )}
        </div>

        <p className={styles.footnote}>
          Seeded by <code>scripts/demo/seed.mjs</code> into PostgreSQL org <code>org_dev</code>.
        </p>
      </section>
    </main>
  );
}
