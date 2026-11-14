/**
 * Session resolver — maps an authenticated `(sid, jti)` (from a verified DFAP1
 * token) to the concrete connection target and the Vault wrap token issued for
 * exactly that capability.
 *
 * The broker never trusts anything in the token beyond identity: it looks up
 * the session record here, authoritatively, on the server side. The `jti` is
 * part of the lookup key, so a capability minted for an earlier connection can
 * never redeem a wrap token staged for a later one.
 *
 * The three lifecycle notifications let the broker tell the control plane what
 * actually happened to the tunnel:
 *  - `markConnected`   — claim the session for this tunnel (false ⇒ lost a race
 *                        with the grace reaper and must not proceed);
 *  - `markDisconnected`— ordinary recoverable drop ⇒ start the grace window;
 *  - `terminate`       — security-fatal event ⇒ no grace, tear down.
 */

import type { SessionTarget } from './protocol/adapter.js';

export interface ResolvedSession {
  target: SessionTarget;
  /** Response-wrapped Vault token for this session's credential (single-use). */
  credentialWrapToken: string;
  /** Session must be in a state that accepts a connection. */
  state: 'ready' | 'connected' | 'idle' | 'disconnected' | 'other';
  org: string;
  sub: string;
}

export interface SessionResolver {
  /** Resolve the session AND the wrap token bound to this exact capability. */
  resolve(sid: string, jti: string): Promise<ResolvedSession | null>;
  /**
   * Record that this tunnel now owns the session. Returns false when the
   * session is no longer connectable (e.g. the grace reaper claimed it first),
   * in which case the caller MUST close the connection.
   */
  markConnected(sid: string): Promise<boolean>;
  /** Ordinary recoverable drop: start the bounded reconnect grace window. */
  markDisconnected(sid: string, reason: string): Promise<void>;
  /** Terminate a session — called on replay detection or protocol violation. */
  terminate(sid: string, reason: string): Promise<void>;
}

export class InMemorySessionResolver implements SessionResolver {
  private readonly sessions = new Map<string, ResolvedSession>();
  public readonly terminated: { sid: string; reason: string }[] = [];
  public readonly disconnected: { sid: string; reason: string }[] = [];
  public readonly connected: string[] = [];
  /** jti values presented by the most recent successful resolve, per sid. */
  public readonly resolvedJti = new Map<string, string>();

  put(sid: string, session: ResolvedSession): void {
    this.sessions.set(sid, session);
  }

  async resolve(sid: string, jti: string): Promise<ResolvedSession | null> {
    const session = this.sessions.get(sid);
    if (!session) return null;
    this.resolvedJti.set(sid, jti);
    return session;
  }

  async markConnected(sid: string): Promise<boolean> {
    const s = this.sessions.get(sid);
    if (!s) return false;
    s.state = 'connected';
    this.connected.push(sid);
    return true;
  }

  async markDisconnected(sid: string, reason: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (s) s.state = 'disconnected';
    this.disconnected.push({ sid, reason });
  }

  async terminate(sid: string, reason: string): Promise<void> {
    this.sessions.delete(sid);
    this.terminated.push({ sid, reason });
  }
}
