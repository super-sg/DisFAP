import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  isConnectable,
  isTerminal,
  type ApiClient,
  type MarketplaceLicense,
  type SessionInfo,
  type WorkspaceTemplate,
} from '../api/client.js';
import { COLD_START_BUDGET_MS, POLL_INTERVAL_MS, type Launching, type LaunchResult } from './launch-types.js';

export interface SessionLaunch {
  /** Non-null while a session is provisioning; the page shows progress instead of the catalog. */
  launching: Launching | null;
  /** Last state the control plane reported — never assumed. */
  serverState: SessionInfo['state'];
  elapsed: number;
  /** Set only when the launch failed or timed out. */
  startError: string | null;
  startWorkspace: (template: WorkspaceTemplate) => Promise<void>;
  startRental: (license: MarketplaceLicense, hours: number) => Promise<void>;
}

/**
 * Owns the "start something and wait for it" state machine for the launch page.
 *
 * The server decides when a session is ready; this hook only polls and reports.
 * It hands the *freshest* connect handle to `onReady`, because `getSession`
 * re-mints a single-use handle on every read and an older one may have expired.
 */
export function useSessionLaunch(api: ApiClient, onReady: (result: LaunchResult) => void): SessionLaunch {
  const [launching, setLaunching] = useState<Launching | null>(null);
  const [serverState, setServerState] = useState<SessionInfo['state']>('requested');
  const [elapsed, setElapsed] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);

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
        // Transient control-plane hiccups during a long cold start must not
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

  const begin = useCallback((failureMessage: string) => {
    setStartError(null);
    setElapsed(0);
    setServerState('requested');
    return (err: unknown) => {
      setStartError(err instanceof Error ? err.message : failureMessage);
    };
  }, []);

  const startWorkspace = useCallback(
    async (template: WorkspaceTemplate): Promise<void> => {
      const onFailure = begin('Failed to start session');
      try {
        const started = await api.startSession(template.id);
        setLaunching({ sessionId: started.sessionId, template });
      } catch (err: unknown) {
        onFailure(err);
      }
    },
    [api, begin],
  );

  const startRental = useCallback(
    async (license: MarketplaceLicense, hours: number): Promise<void> => {
      const onFailure = begin('Failed to rent software license');
      try {
        const result = await api.rentLicense(license.id, hours);
        // A rented license has no template id, so present it as a synthetic
        // template for the progress view and the session header.
        const syntheticTemplate: WorkspaceTemplate = {
          id: license.id,
          name: `${license.softwareName} (${license.version})`,
          description: license.description,
          os: license.os,
          // Marketplace listing responses do not expose recording configuration.
          recording: false,
        };
        setLaunching({ sessionId: result.sessionId, template: syntheticTemplate, telemetry: result.telemetry });
      } catch (err: unknown) {
        onFailure(err);
      }
    },
    [api, begin],
  );

  return { launching, serverState, elapsed, startError, startWorkspace, startRental };
}
