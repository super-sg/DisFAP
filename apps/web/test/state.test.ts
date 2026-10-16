import { describe, expect, it } from 'vitest';
import {
  initialContext,
  isPending,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  SessionMachine,
  transition,
  type ConnContext,
} from '../src/session/state.js';

/** Fold a list of events through the pure reducer. */
function run(events: Parameters<typeof transition>[1][], from: ConnContext = initialContext): ConnContext {
  return events.reduce((ctx, ev) => transition(ctx, ev), from);
}

describe('connection state machine', () => {
  it('walks the happy path idle → connected', () => {
    const ctx = run([
      { type: 'ALLOCATE' },
      { type: 'READY' },
      { type: 'SOCKET_OPEN' },
      { type: 'FIRST_FRAME' },
    ]);
    expect(ctx.state).toBe('connected');
    expect(ctx.channelOpen).toBe(true);
    expect(ctx.reconnectAttempts).toBe(0);
  });

  it('marks the encrypted channel open before the first frame', () => {
    const ctx = run([{ type: 'ALLOCATE' }, { type: 'READY' }, { type: 'SOCKET_OPEN' }]);
    expect(ctx.state).toBe('connecting');
    expect(ctx.channelOpen).toBe(true);
  });

  it('counts transient drops and reconnects up to the limit', () => {
    let ctx = run([{ type: 'ALLOCATE' }, { type: 'READY' }, { type: 'FIRST_FRAME' }]);
    expect(ctx.state).toBe('connected');

    // A transient drop moves to disconnected and increments the attempt count.
    ctx = transition(ctx, { type: 'SOCKET_CLOSED', transient: true });
    expect(ctx.state).toBe('disconnected');
    expect(ctx.reconnectAttempts).toBe(1);

    // RECONNECT resumes connecting; FIRST_FRAME clears the counter again.
    ctx = transition(ctx, { type: 'RECONNECT' });
    expect(ctx.state).toBe('connecting');
    ctx = transition(ctx, { type: 'FIRST_FRAME' });
    expect(ctx.reconnectAttempts).toBe(0);
  });

  it('latches to error after exhausting the reconnect budget', () => {
    let ctx: ConnContext = { ...initialContext, state: 'connected' };
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      ctx = transition(ctx, { type: 'SOCKET_CLOSED', transient: true });
      expect(ctx.state).toBe('disconnected');
      ctx = transition(ctx, { type: 'RECONNECT' });
    }
    // One drop beyond the budget.
    ctx = transition(ctx, { type: 'SOCKET_CLOSED', transient: true });
    expect(ctx.state).toBe('error');
    expect(ctx.error).toMatch(/reconnect attempts/);
  });

  it('does not reconnect on an intentional (non-transient) close', () => {
    let ctx = run([{ type: 'ALLOCATE' }, { type: 'READY' }, { type: 'FIRST_FRAME' }]);
    ctx = transition(ctx, { type: 'SOCKET_CLOSED', transient: false });
    expect(ctx.state).toBe('disconnected');
    expect(ctx.reconnectAttempts).toBe(0);
  });

  it('FATAL wins from any state and RESET returns to idle', () => {
    const err = transition({ ...initialContext, state: 'connected' }, { type: 'FATAL', reason: 'boom' });
    expect(err.state).toBe('error');
    expect(err.error).toBe('boom');
    expect(transition(err, { type: 'RESET' })).toEqual(initialContext);
  });

  it('ignores out-of-order events', () => {
    // FIRST_FRAME with no connection in progress is a no-op.
    expect(transition(initialContext, { type: 'FIRST_FRAME' })).toBe(initialContext);
    // SOCKET_OPEN while idle is a no-op.
    expect(transition(initialContext, { type: 'SOCKET_OPEN' })).toBe(initialContext);
  });

  it('isPending reflects not-yet-live states', () => {
    expect(isPending('allocating')).toBe(true);
    expect(isPending('connecting')).toBe(true);
    expect(isPending('disconnected')).toBe(true);
    expect(isPending('connected')).toBe(false);
    expect(isPending('idle')).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  it('produces bounded, increasing backoff', () => {
    // With jitter pinned to its max (1), delay === exp; verify the cap.
    expect(reconnectDelayMs(1, 1)).toBe(500);
    expect(reconnectDelayMs(2, 1)).toBe(1000);
    expect(reconnectDelayMs(10, 1)).toBe(8000); // capped
    // Jitter keeps the value within [exp/2, exp].
    expect(reconnectDelayMs(3, 0)).toBe(1000); // exp=2000 → exp/2
    expect(reconnectDelayMs(3, 1)).toBe(2000);
  });
});

describe('SessionMachine', () => {
  it('notifies subscribers only on real transitions', () => {
    const m = new SessionMachine();
    const seen: string[] = [];
    m.subscribe((c) => seen.push(c.state));

    m.dispatch({ type: 'ALLOCATE' });
    m.dispatch({ type: 'READY' });
    m.dispatch({ type: 'SOCKET_OPEN' }); // still 'connecting' but channelOpen flips → emits
    m.dispatch({ type: 'FIRST_FRAME' });
    // A no-op dispatch must not notify.
    m.dispatch({ type: 'RECONNECT' });

    expect(m.context.state).toBe('connected');
    expect(seen).toEqual(['allocating', 'connecting', 'connecting', 'connected']);
  });
});
