import type { JSX } from 'react';

import { isConnectable, type SessionInfo } from '../api/client.js';
import { ProgressSteps } from './Progress.js';
import type { Launching } from './launch-types.js';
import styles from './LaunchPage.module.css';

export interface LaunchProgressProps {
  launching: Launching;
  /** Last state the control plane reported (never assumed ready). */
  serverState: SessionInfo['state'];
  elapsed: number;
}

/**
 * The in-flight launch screen. Deliberately shows the server-reported state and
 * the elapsed time rather than a fake determinate bar: a cold AWS start is slow
 * and honest progress beats a bar that lies.
 */
export function LaunchProgress({ launching, serverState, elapsed }: LaunchProgressProps): JSX.Element {
  const phaseIndex = serverState === 'requested' ? 0 : isConnectable(serverState) ? 2 : 1;

  return (
    <main className={styles.page}>
      <section className={styles.progressCard} aria-live="polite">
        <h1 className={styles.progressTitle}>Launching {launching.template.name}</h1>
        <ProgressSteps currentIndex={phaseIndex} elapsedSeconds={elapsed} />

        {launching.telemetry && (
          <div className={styles.telemetryBox}>
            <div className={styles.telemetryTitle}>Provisioning telemetry</div>
            <div className={styles.telemetryRow}>
              <span>Worker provisioning:</span>
              <span>{launching.telemetry.thread1VmSpoolingMs} ms</span>
            </div>
            <div className={styles.telemetryRow}>
              <span>Credential retrieval:</span>
              <span>{launching.telemetry.thread2CredentialRetrievalMs} ms</span>
            </div>
            <div className={styles.telemetryRow}>
              <span>Parallel orchestration total:</span>
              <span>{launching.telemetry.orchestratorTotalMs} ms</span>
            </div>
            <div className={styles.telemetryRow}>
              <span>Credential key fingerprint:</span>
              <span>{launching.telemetry.hsmKeyFingerprint}</span>
            </div>
          </div>
        )}

        {launching.template.recording && (
          <p className={styles.recordingNote}>
            Recording is configured for this template; capture and retention require deployment verification.
          </p>
        )}
      </section>
    </main>
  );
}
