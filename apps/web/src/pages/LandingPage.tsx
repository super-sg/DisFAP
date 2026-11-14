import type { JSX, ReactNode } from 'react';
import { IconArrowRight, IconBox, IconCpu, IconKey, IconLaptop, IconLayers, IconLock, IconServer, IconShield, IconTerminal } from '../ui/Icons.js';
import styles from './LandingPage.module.css';

export interface LandingPageProps {
  onNavigate: (page: 'dashboard' | 'workspaces') => void;
}

const FEATURES: { icon: ReactNode; title: string; desc: string }[] = [
  {
    icon: <IconLaptop size={20} />,
    title: 'Pixel-Only Isolated Sessions',
    desc: 'Rendered pixels streamed over HTML5 canvas. No file transfer, no clipboard bridging, no drive redirection — enforced across four independent layers.',
  },
  {
    icon: <IconServer size={20} />,
    title: 'Ephemeral Worker Instances',
    desc: 'Sessions run on provisioned workers. Ending a session requests instance termination, with a lifecycle reaper as a recovery path.',
  },
  {
    icon: <IconKey size={20} />,
    title: 'Zero-Trust Credential Sealing',
    desc: 'Desktop credentials stay server-side. The browser receives a short-lived, single-use connection handle while Vault supplies credentials to the worker path.',
  },
  {
    icon: <IconShield size={20} />,
    title: 'Session Lifecycle Tracking',
    desc: 'The control plane records session state and teardown events. Full session history and end-to-end recording are not exposed in this frontend.',
  },
];

const LAYERS = [
  {
    label: 'Layer 1',
    title: 'guacd Parameters',
    desc: 'Copy, paste, drive, and print channels disabled server-side. The client cannot influence connection parameters.',
  },
  {
    label: 'Layer 2',
    title: 'RSA-4096 Provider',
    desc: 'Owner credentials sealed at ingest via software-backed RSA-4096. Plaintext is never stored in PostgreSQL.',
  },
  {
    label: 'Layer 3',
    title: 'Two-Thread Orchestrator',
    desc: 'Parallel worker provisioning and credential staging in Vault. Emits a short-lived, single-use capability handle.',
  },
  {
    label: 'Layer 4',
    title: 'Browser Client Sandbox',
    desc: 'Input overlay captures mouse and keystrokes while DOM drag-and-drop, text selection, and context menus are neutralised.',
  },
] as const;

export function LandingPage({ onNavigate }: LandingPageProps): JSX.Element {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <span className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} aria-hidden="true" />
          Zero-Trust Remote Execution Architecture
        </span>

        <h1 className={styles.heroTitle}>
          Remote workspaces with <span className={styles.heroTitleAccent}>controlled data paths</span>
        </h1>

        <p className={styles.heroSub}>
          Run applications in a remote workspace. The browser receives the pixel stream and sends input; broker and client controls block file and clipboard channels.
        </p>

        <button
          className={styles.heroCta}
          onClick={() => onNavigate('workspaces')}
          type="button"
        >
          Launch a workspace
          <IconArrowRight size={16} />
        </button>
      </section>

      <div className={styles.statsBar}>
        <div className={styles.stat}>
          <div className={styles.statValue}>4</div>
          <div className={styles.statLabel}>Isolation Layers</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>60s</div>
          <div className={styles.statLabel}>Token TTL</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>3389</div>
          <div className={styles.statLabel}>xrdp Isolation</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>0</div>
          <div className={styles.statLabel}>Client Binaries</div>
        </div>
      </div>

      <section className={styles.features}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>◆ Architecture</span>
          <h2 className={styles.sectionTitle}>Built for Zero-Trust Remote Access</h2>
          <p className={styles.sectionSub}>
            Pixel-stream restrictions are implemented in the broker and browser. Cloud identity, network, and key configuration must still be validated per deployment.
          </p>
        </div>

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

      <section className={styles.features}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>◆ Security Model</span>
          <h2 className={styles.sectionTitle}>Four Defense-in-Depth Layers</h2>
          <p className={styles.sectionSub}>
            No outbound data channel to the client — enforced independently at protocol, cryptographic, orchestrator, and browser levels.
          </p>
        </div>

        <div className={styles.layerGrid}>
          {LAYERS.map((l, i) => (
            <div key={l.label} className={styles.layerCard}>
              <span className={styles.layerNumber} aria-hidden="true">0{i + 1}</span>
              <div className={styles.layerLabel}>{l.label}</div>
              <h3 className={styles.layerTitle}>{l.title}</h3>
              <p className={styles.layerDesc}>{l.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <strong style={{ color: '#f1f5f9' }}>DisFAP</strong> — Distributed Federated Access Platform · Secure Ephemeral Computing
      </footer>
    </div>
  );
}
