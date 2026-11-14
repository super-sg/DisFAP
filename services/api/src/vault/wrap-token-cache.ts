/**
 * WrapTokenCache — holds single-use Vault response-wrapping tokens between the
 * moment a connect capability is minted (`POST /sessions`, or a later
 * `GET /sessions/:id`) and the broker's `resolve()` for that exact capability.
 *
 * The cache is keyed by `(sessionId, jti)`, not by session alone. That binding is
 * the security property that matters: a capability minted earlier must never be
 * able to redeem a wrap token issued for a later connection attempt. The broker
 * presents the jti from the verified DFAP1 payload; a lookup with the wrong jti
 * simply misses.
 *
 * Vault remains the source of truth. This cache only holds a pointer to a
 * single-use unwrap that can be re-derived from the persisted secret at any
 * time; losing it (an API restart) degrades to "ask for a fresh handle", never
 * to "the credential is gone" (see `issueConnectHandle`).
 *
 * Phase-0 is a single node, so the store is in-process. A multi-node deployment
 * can back this with Redis (`SET NX EX` on the same composite key) without
 * changing callers.
 */

interface Entry {
  token: string;
  expiresAtMs: number;
}

/** Safety valve: a polling client must not grow one session's map unboundedly. */
const MAX_ENTRIES_PER_SESSION = 16;

const keyOf = (sid: string, jti: string): string => `${sid}\u0000${jti}`;

export interface WrapTokenCache {
  /** Stage a wrap token for exactly one capability (`sid` + `jti`). */
  put(sid: string, jti: string, wrapToken: string, ttlSeconds: number): void;
  /**
   * Read-once for this exact capability: returns the token and forgets it.
   * Returns null when absent, already redeemed, or expired.
   */
  take(sid: string, jti: string): string | null;
  /** Forget every outstanding handle for a session (teardown / security kill). */
  drop(sid: string): void;
  /** Number of live entries — observability and tests. */
  size(): number;
}

export class InMemoryWrapTokenCache implements WrapTokenCache {
  private readonly store = new Map<string, Entry & { sid: string; jti: string }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  put(sid: string, jti: string, wrapToken: string, ttlSeconds: number): void {
    this.sweep();
    let forSession = 0;
    for (const entry of this.store.values()) if (entry.sid === sid) forSession += 1;
    if (forSession >= MAX_ENTRIES_PER_SESSION) this.evictOldest(sid);
    this.store.set(keyOf(sid, jti), {
      sid,
      jti,
      token: wrapToken,
      expiresAtMs: this.now() + ttlSeconds * 1000,
    });
  }

  take(sid: string, jti: string): string | null {
    const key = keyOf(sid, jti);
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (entry.expiresAtMs <= this.now()) return null;
    return entry.token;
  }

  drop(sid: string): void {
    for (const [key, entry] of this.store) if (entry.sid === sid) this.store.delete(key);
  }

  size(): number {
    this.sweep();
    return this.store.size;
  }

  /** Drop every expired entry. Bounded work: the map only ever holds handles. */
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.store) if (entry.expiresAtMs <= now) this.store.delete(key);
  }

  private evictOldest(sid: string): void {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.store) {
      if (entry.sid === sid && entry.expiresAtMs < oldest) {
        oldest = entry.expiresAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey) this.store.delete(oldestKey);
  }
}
