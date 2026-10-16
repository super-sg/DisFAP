import { describe, expect, it } from 'vitest';
import {
  transition,
  nextState,
  canTransition,
  isTerminal,
  legalEvents,
  IllegalTransitionError,
  type SessionState,
  type SessionEvent,
} from '../src/state-machine.js';

/** Every legal (from, event) -> to edge, enumerated so the table can't drift. */
const LEGAL: Array<[SessionState, SessionEvent, SessionState]> = [
  ['requested', 'allocate', 'allocating'],
  ['requested', 'fail', 'failed'],
  ['requested', 'terminate', 'terminating'],
  ['allocating', 'ready', 'ready'],
  ['allocating', 'fail', 'failed'],
  ['allocating', 'terminate', 'terminating'],
  ['ready', 'connect', 'connected'],
  ['ready', 'fail', 'failed'],
  ['ready', 'terminate', 'terminating'],
  ['connected', 'idle', 'idle'],
  ['connected', 'disconnect', 'disconnected'],
  ['connected', 'fail', 'failed'],
  ['connected', 'terminate', 'terminating'],
  ['idle', 'resume', 'connected'],
  ['idle', 'disconnect', 'disconnected'],
  ['idle', 'fail', 'failed'],
  ['idle', 'terminate', 'terminating'],
  ['disconnected', 'reconnect', 'connected'],
  ['disconnected', 'fail', 'failed'],
  ['disconnected', 'terminate', 'terminating'],
  ['terminating', 'ended', 'ended'],
  ['terminating', 'fail', 'failed'],
];

/** A representative sample of illegal edges that must throw. */
const ILLEGAL: Array<[SessionState, SessionEvent]> = [
  ['ended', 'connect'],
  ['ended', 'terminate'],
  ['failed', 'allocate'],
  ['requested', 'connect'],
  ['requested', 'ready'],
  ['allocating', 'connect'],
  ['ready', 'idle'],
  ['connected', 'connect'],
  ['disconnected', 'idle'],
  ['terminating', 'connect'],
  ['idle', 'ready'],
];

describe('session state machine', () => {
  it.each(LEGAL)('allows %s --(%s)--> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
    expect(nextState(from, event)).toBe(to);
    expect(canTransition(from, event)).toBe(true);
  });

  it.each(ILLEGAL)('rejects %s --(%s)-->', (from, event) => {
    expect(() => transition(from, event)).toThrow(IllegalTransitionError);
    expect(nextState(from, event)).toBeNull();
    expect(canTransition(from, event)).toBe(false);
  });

  it('marks only ended/failed as terminal, with no outgoing edges', () => {
    expect(isTerminal('ended')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(legalEvents('ended')).toEqual([]);
    expect(legalEvents('failed')).toEqual([]);
    for (const s of ['requested', 'allocating', 'ready', 'connected', 'idle', 'disconnected', 'terminating'] as const) {
      expect(isTerminal(s)).toBe(false);
      expect(legalEvents(s).length).toBeGreaterThan(0);
    }
  });

  it('can always be terminated from any non-terminal state', () => {
    for (const s of ['requested', 'allocating', 'ready', 'connected', 'idle', 'disconnected'] as const) {
      expect(transition(s, 'terminate')).toBe('terminating');
    }
  });
});
