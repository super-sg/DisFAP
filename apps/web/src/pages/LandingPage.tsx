import type { JSX } from 'react';
import styles from './LandingPage.module.css';

export interface LandingPageProps {
  onNavigate: (page: 'dashboard' | 'workspaces') => void;
}

const FEATURES = [
  {
    icon: '🖥',
    title: 'Pixel-Only Sessions',
    desc: 'Rendered pixels over HTML5 canvas. No file transfer, no clipboard, no drive redirection — enforced in four independent layers.',
  },
  {
    icon: '🔥',
    title: 'Ephemeral VMs',
    desc: 'Every session boots a fresh, hardened VM from a golden image. Used once, then destroyed. Never reused across sessions.',
  },
  {
    icon: '🛡',
    title: 'Zero Trust Credentials',
    desc: 'Session credentials never transit the client. The browser receives an opaque 60-second handle — Vault resolves the rest server-side.',
  },
  {
    icon: '📼',
    title: 'Tamper-Evident Audit',
    desc: 'Session recordings streamed to WORM storage with hash-chained integrity. Removal or alteration of any frame is cryptographically detectable.',
  },
] as const;

const LAYERS = [
  {
    label: 'Layer 1',
    title: 'guacd Parameters',
    desc: 'Copy, paste, drive, print disabled server-side. Client never influences connection params.',
  },
  {
    label: 'Layer 2',
    title: 'Instruction Filter',
    desc: 'Strict allowlist on the broker. Only mouse, key, size, sync pass. File/clipboard streams are dropped and logged.',
  },
  {
    label: 'Layer 3',
    title: 'Guest OS Policy',
    desc: 'Channel redirection disabled in the hardened image via OS-level group policy. Survives a compromised broker.',
  },
  {
    label: 'Layer 4',
    title: 'Browser Client',
    desc: 'No file/clipboard handlers attached. Drag, drop, context menu, text selection are all neutralised in the DOM.',
  },
] as const;

export function LandingPage({ onNavigate }: LandingPageProps): JSX.Element {
  return (
    <main className={styles.page}>
      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroGlow} aria-hidden="true" />

        <span className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} aria-hidden="true" />
          Secure by construction
        </span>

        <h1 className={styles.heroTitle}>
          Workspaces that{' '}
          <span className={styles.heroGradientText}>never leak data</span>
        </h1>

        <p className={styles.heroSub}>
          Contractors, auditors, and third parties work on sensitive applications through the browser.
          The endpoint never holds anything but pixels.
        </p>

        <button
          className={styles.heroCta}
          onClick={() => onNavigate('workspaces')}
          type="button"
        >
          Launch a workspace
          <span className={styles.heroCtaArrow} aria-hidden="true">→</span>
        </button>
      </section>

      {/* ── Stats ───────────────────────────────────────────────────────────── */}
      <div className={styles.statsBar}>
        <div className={styles.stat}>
          <div className={styles.statValue}>4</div>
          <div className={styles.statLabel}>Isolation Layers</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>60s</div>
          <div className={styles.statLabel}>Token Lifetime</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>5</div>
          <div className={styles.statLabel}>Teardown Layers</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>0</div>
          <div className={styles.statLabel}>Data Channels</div>
        </div>
      </div>

      {/* ── Features ────────────────────────────────────────────────────────── */}
      <section className={styles.features}>
        <span className={styles.sectionLabel}>◆ Platform</span>
        <h2 className={styles.sectionTitle}>Built for zero-trust access</h2>
        <p className={styles.sectionSub}>
          Every guarantee is enforced in code — not configured in a single place. Each layer assumes the previous ones have failed.
        </p>

        <div className={styles.featureGrid}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden="true">{f.icon}</div>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Security Layers ─────────────────────────────────────────────────── */}
      <section className={styles.security}>
        <div className={styles.securityInner}>
          <span className={styles.sectionLabel}>◆ Security Model</span>
          <h2 className={styles.sectionTitle}>Four layers, zero trust</h2>
          <p className={styles.sectionSub}>
            No data channel to the client — enforced independently at every level so no single misconfiguration opens a path.
          </p>

          <div className={styles.layerGrid}>
            {LAYERS.map((l, i) => (
              <div key={l.label} className={styles.layerCard}>
                <span className={styles.layerNumber} aria-hidden="true">{i + 1}</span>
                <div className={styles.layerLabel}>{l.label}</div>
                <h3 className={styles.layerTitle}>{l.title}</h3>
                <p className={styles.layerDesc}>{l.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <span className={styles.footerBrand}>DisFAP</span> — Distributed Federated Access Platform
      </footer>
    </main>
  );
}
