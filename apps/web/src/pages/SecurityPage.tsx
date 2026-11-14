import type { JSX } from 'react';
import { IconKey, IconLock, IconShield } from '../ui/Icons.js';
import styles from './SecurityPage.module.css';

/** Security implementation notes; this page is not a live infrastructure monitor. */
export function SecurityPage(): JSX.Element {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Security controls</h1>
        <p className={styles.subtitle}>
          Implementation summary, not a live posture check. Cloud configuration and operational controls require validation in the deployed environment.
        </p>
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="implemented-controls">
          <div className={styles.cardHeader}>
            <IconShield size={18} aria-hidden="true" />
            <h2 id="implemented-controls" className={styles.cardTitle}>Implemented in code</h2>
          </div>
          <div className={styles.layerList}>
            <div className={styles.layerItem}>
              <div className={styles.layerHead}>
                <span className={styles.layerName}>Pixel-stream restrictions</span>
                <span className={styles.layerTag}>Broker + client</span>
              </div>
              <p className={styles.layerDesc}>
                The broker filters file, clipboard, pipe, and argument streams; Guacamole connection parameters disable copy, paste, drive, printing, and file transfer. The browser attaches no file or clipboard handlers.
              </p>
            </div>
            <div className={styles.layerItem}>
              <div className={styles.layerHead}>
                <span className={styles.layerName}>Credential sealing</span>
                <span className={styles.layerTag}>Software key</span>
              </div>
              <p className={styles.layerDesc}>
                Submitted credentials are sealed with RSA-OAEP-SHA256 using a software-backed key (4096-bit default). This is not hardware HSM protection; encrypted credential payloads are stored by the marketplace service.
              </p>
            </div>
            <div className={styles.layerItem}>
              <div className={styles.layerHead}>
                <span className={styles.layerName}>Session access and teardown</span>
                <span className={styles.layerTag}>Control plane</span>
              </div>
              <p className={styles.layerDesc}>
                Connect handles are single-use and short-lived. Session end requests trigger cloud instance termination, with a lifecycle reaper as a recovery path.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="deployment-validation">
          <div className={styles.cardHeader}>
            <IconLock size={18} aria-hidden="true" />
            <h2 id="deployment-validation" className={styles.cardTitle}>Deployment validation and planned work</h2>
          </div>
          <div className={styles.layerList}>
            <div className={styles.layerItem}>
              <div className={styles.layerHead}>
                <span className={styles.layerName}>Validate per environment</span>
                <IconKey size={15} aria-hidden="true" />
              </div>
              <p className={styles.layerDesc}>
                Verify cloud IAM, network boundaries, TLS, Vault policy, key custody, and instance cleanup in the target deployment. This page does not query or monitor those systems.
              </p>
            </div>
            <div className={styles.layerItem}>
              <div className={styles.layerHead}>
                <span className={styles.layerName}>Not represented as production controls</span>
              </div>
              <p className={styles.layerDesc}>
                End-to-end WORM session recording and production-ready Stripe billing are not claimed. Hardware-backed key custody and live infrastructure posture reporting require further implementation and verification.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
