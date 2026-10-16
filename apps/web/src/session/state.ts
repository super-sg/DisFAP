/**
 * Client-side connection state machine for a live pixel session.
 *
 * This is distinct from the *server* session lifecycle (ServerSessionState in
 * api/client.ts). It models only what the browser knows about its own tunnel:
 *
 *   idle ──ALLOCATE──▶ allocating ──READY──▶ connecting ──FIRST_FRAME──▶ connected
 *                                     ▲                                      │
 *                                     │ RECONNECT                           │ SOCKET_CLOSED(transient)
 *                                     │                                      ▼
 *                                     └──────────────── disconnected ◀───────┘
 *
 *   FATAL from anywhere ──▶ error        RESET from anywhere ──▶ idle
 *
 * Reconnect policy (Phase-0): a transient socket close moves us to
 * `disconnected` and the controller re-fetches a *fresh* DFAP1 handle before
 * dispatching RECONNECT (the old one is single-use and likely expired). After
 * MAX_RECONNECT_ATTEMPTS the machine latches to `error`.
 */

export type ConnState =
  | 'idle'
  | 'allocating'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ConnContext {
  state: ConnState;
  /** Human-readable failure reason when `state === 'error'`. */
  error: string | null;
  /** Consecutive transient closes since the last successful frame. */
  reconnectAttempts: number;
  /** True once the encrypted WebSocket channel is open (pre-first-frame). */
  channelOpen: boolean;
}

export type ConnEvent =
  /** Begin provisioning a session (server-side allocation). */
  | { type: 'ALLOCATE' }
  /** Session became connectable; begin opening the tunnel. */
  | { type: 'READY' }
  /** The WebSocket to the broker is open (token accepted, channel established). */
  | { type: 'SOCKET_OPEN' }
  /** First rendered frame / Guacamole CONNECTED — the session is live. */
  | { type: 'FIRST_FRAME' }
  /** The socket closed. `transient` distinguishes a drop from an intended end. */
  | { type: 'SOCKET_CLOSED'; transient: boolean }
  /** Start a fresh reconnect attempt (controller has a new handle in hand). */
  | { type: 'RECONNECT' }
  /** Unrecoverable failure. */
  | { type: 'FATAL'; reason: string }
  /** Return to the initial state (e.g. user ended the session). */
  | { type: 'RESET' };

export const MAX_RECONNECT_ATTEMPTS = 5;

export const initialContext: ConnContext = {
  state: 'idle',
  error: null,
  reconnectAttempts: 0,
  channelOpen: false,
};

/**
 * Compute a bounded exponential backoff (with light jitter) for reconnect
 * attempt N (1-based). ~0.5s, 1s, 2s, 4s, 8s, capped at 8s.
 */
export function reconnectDelayMs(attempt: number, jitter: number = Math.random()): number {
  const base = 500;
  const max = 8000;
  const exp = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  // Full jitter over [exp/2, exp] to avoid thundering-herd reconnects.
  return Math.round(exp / 2 + (jitter * exp) / 2);
}

/** Pure transition function — the single source of truth, easy to unit test. */
export function transition(ctx: ConnContext, event: ConnEvent): ConnContext {
  switch (event.type) {
    case 'RESET':
      return { ...initialContext };

    case 'FATAL':
      return { ...ctx, state: 'error', error: event.reason, channelOpen: false };

    case 'ALLOCATE':
      // Allowed from any non-live state; clears prior error and counters.
      if (ctx.state === 'connected' || ctx.state === 'connecting') return ctx;
      return { ...initialContext, state: 'allocating' };

    case 'READY':
      // From provisioning, or when kicking off a reconnect attempt.
      if (ctx.state === 'allocating' || ctx.state === 'disconnected' || ctx.state === 'connecting') {
        return { ...ctx, state: 'connecting', error: null, channelOpen: false };
      }
      return ctx;

    case 'SOCKET_OPEN':
      if (ctx.state === 'connecting') return { ...ctx, channelOpen: true };
      return ctx;

    case 'FIRST_FRAME':
      if (ctx.state === 'connecting') {
        // A successful frame resets the reconnect budget.
        return { ...ctx, state: 'connected', error: null, reconnectAttempts: 0, channelOpen: true };
      }
      return ctx;

    case 'SOCKET_CLOSED': {
      if (ctx.state === 'idle' || ctx.state === 'error') return ctx;
      if (!event.transient) {
        // Intentional close (user ended / normal disconnect): no reconnect.
        return { ...ctx, state: 'disconnected', channelOpen: false };
      }
      const attempts = ctx.reconnectAttempts + 1;
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        return {
          ...ctx,
          state: 'error',
          error: `connection lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
          channelOpen: false,
        };
      }
      return { ...ctx, state: 'disconnected', reconnectAttempts: attempts, channelOpen: false };
    }

    case 'RECONNECT':
      if (ctx.state === 'disconnected') {
        return { ...ctx, state: 'connecting', error: null, channelOpen: false };
      }
      return ctx;

    default:
      return ctx;
  }
}

/** True while the machine is still waiting to show the first pixel. */
export function isPending(state: ConnState): boolean {
  return state === 'allocating' || state === 'connecting' || state === 'disconnected';
}

/**
 * Tiny observable wrapper around `transition` for use in React/effects. Kept
 * deliberately thin: all logic lives in the pure reducer above.
 */
export class SessionMachine {
  private ctx: ConnContext = { ...initialContext };
  private readonly listeners = new Set<(ctx: ConnContext) => void>();

  get context(): ConnContext {
    return this.ctx;
  }

  dispatch(event: ConnEvent): ConnContext {
    const next = transition(this.ctx, event);
    if (next !== this.ctx) {
      this.ctx = next;
      for (const fn of this.listeners) fn(next);
    }
    return this.ctx;
  }

  subscribe(fn: (ctx: ConnContext) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
