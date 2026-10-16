/**
 * Session state machine (pure).
 *
 * The set of states mirrors the `SessionState` enum in schema.prisma exactly.
 * All lifecycle mutations in the control plane funnel through `transition()`
 * so that an illegal jump (e.g. `ended` -> `connected`) is impossible to
 * express by accident — it throws rather than silently corrupting a session.
 *
 * This module has no I/O and no dependencies; it is trivially unit-testable.
 */

export type SessionState =
  | 'requested'
  | 'allocating'
  | 'ready'
  | 'connected'
  | 'idle'
  | 'disconnected'
  | 'terminating'
  | 'ended'
  | 'failed';

/**
 * Events that drive the machine. Each names a concrete thing that happened,
 * not a target state, so the same event can mean different transitions from
 * different states (e.g. `disconnect` from `connected` vs `idle`).
 */
export type SessionEvent =
  | 'allocate' // begin claiming/launching a VM
  | 'ready' // VM is up and a connect token can be minted
  | 'connect' // client established the pixel tunnel
  | 'idle' // idle-timeout watcher fired (no input)
  | 'resume' // input resumed after idle
  | 'disconnect' // client tunnel dropped (may reconnect)
  | 'reconnect' // client re-established the tunnel
  | 'terminate' // teardown requested (user/admin/timeout/reaper)
  | 'ended' // teardown completed
  | 'fail'; // unrecoverable error at any pre-terminal stage

/** Terminal states have no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set<SessionState>(['ended', 'failed']);

/**
 * The complete transition table. A `(from, event)` pair absent from this map
 * is, by definition, illegal.
 */
const TRANSITIONS: Readonly<Record<SessionState, Readonly<Partial<Record<SessionEvent, SessionState>>>>> = {
  requested: { allocate: 'allocating', fail: 'failed', terminate: 'terminating' },
  allocating: { ready: 'ready', fail: 'failed', terminate: 'terminating' },
  ready: { connect: 'connected', fail: 'failed', terminate: 'terminating' },
  connected: { idle: 'idle', disconnect: 'disconnected', fail: 'failed', terminate: 'terminating' },
  idle: { resume: 'connected', disconnect: 'disconnected', fail: 'failed', terminate: 'terminating' },
  disconnected: { reconnect: 'connected', fail: 'failed', terminate: 'terminating' },
  terminating: { ended: 'ended', fail: 'failed' },
  ended: {},
  failed: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly event: SessionEvent,
  ) {
    super(`illegal session transition: ${from} --(${event})--> ✗`);
    this.name = 'IllegalTransitionError';
  }
}

/** The state reached by applying `event` in state `from`, or `null` if illegal. */
export function nextState(from: SessionState, event: SessionEvent): SessionState | null {
  return TRANSITIONS[from][event] ?? null;
}

/** True iff `event` is legal in state `from`. */
export function canTransition(from: SessionState, event: SessionEvent): boolean {
  return nextState(from, event) !== null;
}

/**
 * Apply `event` to `from`, returning the resulting state.
 * @throws {IllegalTransitionError} if the transition is not in the table.
 */
export function transition(from: SessionState, event: SessionEvent): SessionState {
  const to = nextState(from, event);
  if (to === null) throw new IllegalTransitionError(from, event);
  return to;
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.has(state);
}

/** All legal events from a given state — handy for API affordances/tests. */
export function legalEvents(from: SessionState): SessionEvent[] {
  return Object.keys(TRANSITIONS[from]) as SessionEvent[];
}
