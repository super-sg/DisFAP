import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ApiClient, isConnectable, isTerminal } from '../api/client.js';
import type { ConnectCredentials } from '../api/client.js';
import type { LaunchResult } from './LaunchPage.js';
import { GuacsessionView } from './GuacsessionView.js';
import { ProgressSteps } from './Progress.js';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs, SessionMachine, type ConnContext } from './state.js';
import styles from './SessionView.module.css';

export interface SessionViewProps {
  api: ApiClient;
  /** The connectable session handed up by LaunchPage. */
  initial: LaunchResult;
  /** Called when the user ends the session and should return to the launcher. */
  onExit: () => void;
}

/**
 * SessionView owns a *live* session: it mounts GuacsessionView, feeds tunnel
 * events into the connection state machine (state.ts), and drives Phase-0
 * reconnect — which means re-fetching a fresh single-use DFAP1 handle, since
 * the previous one is spent. Reconnecting is modelled as remounting
 * GuacsessionView with the new handle (the `attemptKey`).
 */
export function SessionView({ api, initial, onExit }: SessionViewProps): JSX.Element {
  const sessionId = initial.session.id;
  const recording = initial.template.recording;

  const machine = useMemo(() => new SessionMachine(), []);
  const [ctx, setCtx] = useState<ConnContext>(machine.context);

  // Current connect credentials driving the mounted GuacsessionView. Replaced
  // with a fresh handle on every reconnect.
  const [connect, setConnect] = useState<ConnectCredentials>(initial.connect);
  // Bumped to force a clean remount of GuacsessionView on each connect attempt.
  const [attemptKey, setAttemptKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Guards against any late async work firing after the user exits.
  const endedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One lifecycle event per mount attempt: `onerror` and the resulting socket
  // close can both fire for the same drop, which must not consume two retries.
  const closedRef = useRef(false);

  useEffect(() => {
    const unsub = machine.subscribe(setCtx);
    // We arrive already-connectable from LaunchPage, so seed the machine into
    // its connecting phase.
    machine.dispatch({ type: 'ALLOCATE' });
    machine.dispatch({ type: 'READY' });
    return () => {
      unsub();
      endedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [machine]);

  // A fresh mount is a fresh connection attempt.
  useEffect(() => {
    closedRef.current = false;
  }, [attemptKey]);

  /**
   * Ask the control plane for a brand-new capability + Vault handle, then
   * remount GuacsessionView with it. The previous handle is spent (its jti was
   * burned and its wrap token consumed), so there is no reuse path.
   *
   * Terminal server state ends the UI; a *missing* handle on a still-live
   * session is treated as transient and retried within the same bounded budget.
   * No credential ever enters component state — only the opaque token.
   */
  const requestFreshHandle = useCallback(
    (attempt: number, immediate = false) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const delay = immediate ? 0 : reconnectDelayMs(attempt);
      timerRef.current = setTimeout(() => {
        if (endedRef.current) return;
        void (async () => {
          try {
            const info = await api.getSession(sessionId);
            if (endedRef.current) return;

            if (isTerminal(info.state)) {
              machine.dispatch({
                type: 'EXPIRED',
                reason:
                  info.state === 'ended'
                    ? 'This session has ended.'
                    : `This session is no longer available (${info.state}).`,
              });
              return;
            }

            if (isConnectable(info.state) && info.connect) {
              setConnect(info.connect); // fresh, single-use capability
              setAttemptKey((k) => k + 1); // remount GuacsessionView → reconnect
              machine.dispatch({ type: 'READY' });
              return;
            }

            // Disconnected *without* a handle means the server's grace window
            // closed before we got back; it is not retryable.
            if (info.state === 'disconnected') {
              machine.dispatch({ type: 'EXPIRED', reason: 'The reconnect window has expired.' });
              return;
            }

            if (attempt >= MAX_RECONNECT_ATTEMPTS) {
              machine.dispatch({ type: 'FATAL', reason: 'Could not obtain a fresh connection handle.' });
              return;
            }
            requestFreshHandle(attempt + 1);
          } catch (err: unknown) {
            if (endedRef.current) return;
            if (attempt >= MAX_RECONNECT_ATTEMPTS) {
              machine.dispatch({
                type: 'FATAL',
                reason: err instanceof Error ? err.message : 'reconnect failed',
              });
              return;
            }
            requestFreshHandle(attempt + 1);
          }
        })();
      }, delay);
    },
    [api, sessionId, machine],
  );

  const handleClose = useCallback(
    (transient: boolean) => {
      // Non-transient means GuacsessionView's own cleanup ran (unmount / user
      // end). It can arrive after a reconnect remounted the component, so
      // treating it as a state change would knock the fresh attempt back to
      // `disconnected`. The user-end path already dispatched RESET; ignore it.
      if (!transient) return;
      if (closedRef.current) return;
      closedRef.current = true;
      const next = machine.dispatch({ type: 'SOCKET_CLOSED', transient: true });
      // Only auto-reconnect on an unexpected drop that hasn't exhausted budget.
      if (next.state === 'disconnected' && !endedRef.current) {
        requestFreshHandle(next.reconnectAttempts);
      }
    },
    [machine, requestFreshHandle],
  );

  const handleError = useCallback(
    (reason: string) => {
      // A transport/protocol error is a drop from the browser's point of view.
      // Retry within the budget; only surface it if reconnection is exhausted.
      if (closedRef.current) return;
      closedRef.current = true;
      const next = machine.dispatch({ type: 'SOCKET_CLOSED', transient: true });
      if (!endedRef.current && next.state === 'disconnected') {
        requestFreshHandle(next.reconnectAttempts);
      } else if (next.state === 'error') {
        machine.dispatch({ type: 'FATAL', reason });
      }
    },
    [machine, requestFreshHandle],
  );

  const endSession = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    setEndError(null);
    endedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await api.endSession(sessionId);
      machine.dispatch({ type: 'RESET' });
      onExit();
    } catch (err: unknown) {
      endedRef.current = false;
      setEnding(false);
      setEndError(err instanceof Error ? err.message : 'Could not end this session. Try again.');
    }
  }, [api, sessionId, machine, onExit, ending]);

  const retryNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    machine.dispatch({ type: 'RESET' });
    machine.dispatch({ type: 'ALLOCATE' });
    requestFreshHandle(1, true);
  }, [machine, requestFreshHandle]);

  const overlay = renderOverlay(ctx, retryNow, endSession);

  return (
    <div className={styles.root}>
      <div className={styles.viewport}>
        <GuacsessionView
          key={attemptKey}
          brokerUrl={connect.brokerUrl}
          token={connect.token}
          onChannelOpen={() => machine.dispatch({ type: 'SOCKET_OPEN' })}
          onConnected={() => machine.dispatch({ type: 'FIRST_FRAME' })}
          onClose={handleClose}
          onError={handleError}
        />
        {overlay}
      </div>

      <div className={styles.chrome}>
        <span className={styles.title}>{initial.template.name}</span>
        {ctx.state === 'connected' && (
          <span className={styles.readyBadge} role="status">
            <span className={styles.readyDot} aria-hidden="true" /> Connected
          </span>
        )}
        <span className={styles.duration} aria-label="Time in this browser view" title="Time in this browser view">
          {formatDuration(elapsed)}
        </span>
        {recording && (
          <span
            className={styles.recordingConfigured}
            title="Template recording is enabled; capture and retention are not verified as end-to-end WORM."
            aria-label="Template recording enabled; capture and retention are not verified"
          >
            Recording configured
          </span>
        )}
        {endError && <span className={styles.endError} role="alert">{endError}</span>}
        <span className={styles.spacer} />
        <button type="button" className={styles.endButton} onClick={() => void endSession()} disabled={ending}>
          {ending ? 'Ending…' : 'End session'}
        </button>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Overlay shown until the first frame arrives, or on drop / error. */function renderOverlay(
  ctx: ConnContext,
  onRetry: () => void,
  onExit: () => void,
): JSX.Element | null {
  if (ctx.state === 'connected') return null;

  if (ctx.state === 'expired') {
    return (
      <div className={styles.overlay} role="alert">
        <div className={styles.overlayCard}>
          <h2 className={styles.overlayTitle}>Session ended</h2>
          <p className={styles.overlayText}>{ctx.error ?? 'This session has ended.'}</p>
          <div className={styles.overlayActions}>
            <button type="button" className={styles.exitButton} onClick={onExit}>
              Back to workspaces
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ctx.state === 'error') {
    return (
      <div className={styles.overlay} role="alert">
        <div className={styles.overlayCard}>
          <h2 className={styles.overlayTitle}>Session disconnected</h2>
          <p className={styles.overlayText}>{ctx.error ?? 'The connection was lost.'}</p>
          <div className={styles.overlayActions}>
            <button type="button" className={styles.retryButton} onClick={onRetry}>
              Try again
            </button>
            <button type="button" className={styles.exitButton} onClick={onExit}>
              Back to workspaces
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ctx.state === 'disconnected') {
    return (
      <div className={styles.overlay} aria-live="polite">
        <div className={styles.overlayCard}>
          <h2 className={styles.overlayTitle}>Reconnecting…</h2>
          <p className={styles.overlayText}>
            The connection dropped. Attempt {ctx.reconnectAttempts} of {MAX_RECONNECT_ATTEMPTS}.
          </p>
        </div>
      </div>
    );
  }

  // allocating / connecting → show the encrypted-channel & connecting phases.
  const phaseIndex = ctx.channelOpen ? 3 : 2;
  return (
    <div className={styles.overlay} aria-live="polite">
      <div className={styles.overlayCard}>
        <ProgressSteps currentIndex={phaseIndex} />
      </div>
    </div>
  );
}
