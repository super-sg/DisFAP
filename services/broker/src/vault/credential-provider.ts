/**
 * Credential provider — fetches the session VM credential server-side, at
 * connect time, exactly once (ADR-002).
 *
 * Production: Vault. The control plane writes the per-session credential to
 * `secret/sessions/{sid}/rdp` with a short TTL and hands the broker a
 * *response-wrapped* single-use token. The broker unwraps it once; a second
 * unwrap fails, which is itself a tamper signal. The credential therefore
 * exists in the broker's memory for the lifetime of one connect() call and
 * nowhere else — never in the DB in plaintext, never in a log, never toward
 * the browser.
 *
 * Phase-0 / tests: a static provider backed by an in-memory map, satisfying
 * the same read-once contract so calling code is identical across phases.
 */

import type { SessionCredential } from '../protocol/adapter.js';

export interface CredentialProvider {
  /**
   * Resolve the credential for a session. `wrapToken` is the response-wrapped
   * Vault token issued by the control plane for this session; it is
   * single-use. Throws if already consumed, expired, or missing.
   */
  fetch(sid: string, wrapToken: string): Promise<SessionCredential>;
}

export class CredentialConsumedError extends Error {
  constructor(sid: string) {
    super(`credential for session ${sid} already consumed or expired`);
    this.name = 'CredentialConsumedError';
  }
}

/** Phase-0 provider: read-once semantics over an in-memory store. */
export class StaticCredentialProvider implements CredentialProvider {
  private readonly store = new Map<string, { token: string; cred: SessionCredential }>();

  /** Control-plane side: stage a credential and get its single-use token. */
  put(sid: string, token: string, cred: SessionCredential): void {
    this.store.set(sid, { token, cred });
  }

  async fetch(sid: string, wrapToken: string): Promise<SessionCredential> {
    const entry = this.store.get(sid);
    if (!entry || entry.token !== wrapToken) throw new CredentialConsumedError(sid);
    this.store.delete(sid); // read-once: consume on fetch
    return entry.cred;
  }
}
