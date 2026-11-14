/**
 * Shared launch types and tuning constants.
 *
 * Kept apart from the components so the launch hook, the progress view and the
 * page shell can all depend on the same definitions without importing each
 * other (which would form a cycle through `LaunchPage`).
 */

import type { ConnectCredentials, SessionInfo, WorkspaceTemplate } from '../api/client.js';

/** Session context handed up once the workspace is connectable. */
export interface LaunchResult {
  session: SessionInfo;
  template: WorkspaceTemplate;
  connect: ConnectCredentials;
}

/** A launch in flight: what to show while the control plane provisions. */
export interface Launching {
  sessionId: string;
  template: WorkspaceTemplate;
  telemetry?: {
    thread1VmSpoolingMs: number;
    thread2CredentialRetrievalMs: number;
    orchestratorTotalMs: number;
    hsmKeyFingerprint: string;
  };
}

/** Poll cadence and overall budget for the (slow) cold start. */
export const POLL_INTERVAL_MS = 2_500;

// A real AWS cold start boots a stock image and installs its desktop, so allow
// a generous budget; the server only reports `ready` once the guest is really up.
export const COLD_START_BUDGET_MS = 600_000; // 10 min

/** Durations offered in the rental picker. The API accepts 1..MAX_RENTAL_HOURS. */
export const RENTAL_HOUR_DURATIONS = [1, 2, 4, 8] as const;

export const OS_ICON: Record<string, string> = {
  windows: '⊞',
  linux: '🐧',
};

/**
 * A dedicated, non-personal demo credential for the licensed app. Generated in
 * the browser so it is never typed by, or reused from, a real person.
 */
export function demoPassword(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `Dfap-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
