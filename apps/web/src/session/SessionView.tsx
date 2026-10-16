import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ApiClient, isConnectable } from '../api/client.js';
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

  // Guards against any late async work firing after the user exits.
  const endedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  const scheduleReconnect = useCallback(
    (attempt: number) => {
      const delay = reconnectDelayMs(attempt);
      timerRef.current = setTimeout(() => {
        if (endedRef.current) return;
        void (async () => {
          try {
            const info = await api.getSession(sessionId);
            if (endedRef.current) return;
            if (isConnectable(info.state) && info.connect) {
              setConnect(info.connect); // fresh, single-use handle
              setAttemptKey((k) => k + 1); // remount GuacsessionView → reconnect
              machine.dispatch({ type: 'RECONNECT' });
            } else {
              machine.dispatch({ type: 'FATAL', reason: `workspace no longer connectable (${info.state})` });
            }
          } catch (err: unknown) {
            if (endedRef.current) return;
            machine.dispatch({ type: 'FATAL', reason: err instanceof Error ? err.message : 'reconnect failed' });
          }
        })();
      }, delay);
    },
    [api, sessionId, machine],
  );

  const handleClose = useCallback(
    (transient: boolean) => {
      const next = machine.dispatch({ type: 'SOCKET_CLOSED', transient });
      // Only auto-reconnect on an unexpected drop that hasn't exhausted budget.
      if (transient && !endedRef.current && next.state === 'disconnected') {
        scheduleReconnect(next.reconnectAttempts);
      }
    },
    [machine, scheduleReconnect],
  );

  const endSession = useCallback(() => {
    endedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    machine.dispatch({ type: 'RESET' });
    // Best-effort teardown request; the server's reaper is the backstop.
    void api.endSession(sessionId).catch(() => undefined);
    onExit();
  }, [api, sessionId, machine, onExit]);

  const retryNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    machine.dispatch({ type: 'RESET' });
    machine.dispatch({ type: 'ALLOCATE' });
    void (async () => {
      try {
        const info = await api.getSession(sessionId);
        if (endedRef.current) return;
        if (isConnectable(info.state) && info.connect) {
          setConnect(info.connect);
          setAttemptKey((k) => k + 1);
          machine.dispatch({ type: 'READY' });
        } else {
          machine.dispatch({ type: 'FATAL', reason: `workspace no longer connectable (${info.state})` });
        }
      } catch (err: unknown) {
        machine.dispatch({ type: 'FATAL', reason: err instanceof Error ? err.message : 'retry failed' });
      }
    })();
  }, [api, sessionId, machine]);

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
          onError={(reason) => machine.dispatch({ type: 'FATAL', reason })}
        />
        {overlay}
      </div>

      <div className={styles.chrome}>
        <span className={styles.title}>{initial.template.name}</span>
        {recording && (
          // Persistent recording indicator — this workspace is recorded (WORM).
          <span className={styles.recording} role="status" aria-label="This session is being recorded">
            <span className={styles.recDot} aria-hidden="true" /> Recording
          </span>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.endButton} onClick={endSession}>
          End session
        </button>
      </div>
    </div>
  );
}

/** Overlay shown until the first frame arrives, or on drop / error. */
function renderOverlay(
  ctx: ConnContext,
  onRetry: () => void,
  onExit: () => void,
): JSX.Element | null {
  if (ctx.state === 'connected') return null;

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
