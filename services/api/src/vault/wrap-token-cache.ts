/**
 * WrapTokenCache — holds the single-use Vault wrap token for a session between
 * `POST /sessions` (mint) and the broker's `resolve()` (connect), so the
 * resolver can hand it to the broker WITHOUT the token ever touching Postgres.
 *
 * The DFAP1 connect token has a 60s TTL, so this is a short-lived, in-process
 * cache — a good fit for Phase-0's single node. A multi-node deployment would
 * back this with Redis (SET NX EX) or re-wrap on demand from Vault; the
 * interface is the seam that makes that swap invisible to callers.
 */

export interface WrapTokenCache {
  put(sid: string, wrapToken: string, ttlSeconds: number): void;
  /** Read-once: returns the token and forgets it (mirrors single-use semantics). */
  take(sid: string): string | null;
  drop(sid: string): void;
}

export class InMemoryWrapTokenCache implements WrapTokenCache {
  private readonly store = new Map<string, { token: string; expiresAtMs: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  put(sid: string, wrapToken: string, ttlSeconds: number): void {
    this.store.set(sid, { token: wrapToken, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }

  take(sid: string): string | null {
    const entry = this.store.get(sid);
    if (!entry) return null;
    this.store.delete(sid);
    if (entry.expiresAtMs <= this.now()) return null;
    return entry.token;
  }

  drop(sid: string): void {
    this.store.delete(sid);
  }
}
