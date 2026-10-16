import type { JSX } from 'react';
import styles from './Progress.module.css';

/**
 * The four honest, named phases a session moves through before pixels appear.
 * Deliberately descriptive of what is actually happening server-side — no fake
 * spinners, no invented steps. A real cold start boots a fresh VM and brings up
 * its desktop, which can take several minutes on a first boot, so the phase
 * only advances when the server has genuinely confirmed it (see
 * pool/readiness.ts) — the wait is accounted-for, never faked.
 */
export const SESSION_PHASES = [
  {
    label: 'Requesting isolated workspace',
    detail: 'Asking the cloud for a fresh, single-use virtual machine.',
  },
  {
    label: 'Preparing the remote desktop',
    detail: 'Booting the VM and installing its desktop environment. A first boot can take several minutes.',
  },
  {
    label: 'Establishing encrypted channel',
    detail: 'The workspace is up and reachable — opening the pixel tunnel to the session broker.',
  },
  {
    label: 'Connecting',
    detail: 'Negotiating the remote display and waiting for the first frame.',
  },
] as const;

export interface ProgressStepsProps {
  /** Index of the phase currently in progress (0-3). */
  currentIndex: number;
  /** Optional elapsed seconds, shown against the active step. */
  elapsedSeconds?: number;
}

/** Renders the four phases with done / active / pending affordances. */
export function ProgressSteps({ currentIndex, elapsedSeconds }: ProgressStepsProps): JSX.Element {
  return (
    <ol className={styles.steps} aria-label="Session startup progress">
      {SESSION_PHASES.map((phase, i) => {
        const status = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
        return (
          <li key={phase.label} className={styles.step} data-status={status} aria-current={status === 'active'}>
            <span className={styles.marker} aria-hidden="true">
              {status === 'done' ? '✓' : status === 'active' ? '' : ''}
            </span>
            <span className={styles.body}>
              <span className={styles.label}>{phase.label}</span>
              {status === 'active' && (
                <span className={styles.detail}>
                  {phase.detail}
                  {elapsedSeconds !== undefined && elapsedSeconds > 0 ? ` (${elapsedSeconds}s elapsed)` : ''}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
