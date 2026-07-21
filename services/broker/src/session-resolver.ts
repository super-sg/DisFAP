/**
 * Session resolver — maps an authenticated `sid` (from a verified DFAP1
 * token) to the concrete connection target and the Vault wrap-token needed to
 * fetch its credential.
 *
 * The broker never trusts anything in the token beyond identity: it looks up
 * the session record here, authoritatively, on the server side. In production
 * this is a read against the control-plane database (or a signed RPC to the
 * API). Phase-0 / tests use an in-memory implementation.
 */

import type { SessionTarget } from './protocol/adapter.js';

export interface ResolvedSession {
  target: SessionTarget;
  /** Response-wrapped Vault token for this session's credential (single-use). */
  credentialWrapToken: string;
  /** Session must be in a state that accepts a connection. */
  state: 'ready' | 'connected' | 'idle' | 'other';
  org: string;
  sub: string;
}

export interface SessionResolver {
  resolve(sid: string): Promise<ResolvedSession | null>;
  /** Record that a session is now connected (idempotent). */
  markConnected(sid: string): Promise<void>;
  /** Terminate a session — called on replay detection or protocol violation. */
  terminate(sid: string, reason: string): Promise<void>;
}

export class InMemorySessionResolver implements SessionResolver {
  private readonly sessions = new Map<string, ResolvedSession>();
  public readonly terminated: { sid: string; reason: string }[] = [];
  public readonly connected: string[] = [];

  put(sid: string, session: ResolvedSession): void {
    this.sessions.set(sid, session);
  }

  async resolve(sid: string): Promise<ResolvedSession | null> {
    return this.sessions.get(sid) ?? null;
  }

  async markConnected(sid: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (s) s.state = 'connected';
    this.connected.push(sid);
  }

  async terminate(sid: string, reason: string): Promise<void> {
    this.sessions.delete(sid);
    this.terminated.push({ sid, reason });
  }
}
