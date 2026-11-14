/**
 * Single-use nonce (jti) burn list.
 *
 * Production: Redis via `SET key 1 NX EX ttl` — atomic first-use check.
 * Phase-0 / tests: in-memory equivalent below. The interface is the contract;
 * `burn` returns true iff this is the first time the key was seen.
 */

export interface NonceStore {
  burn(key: string, ttlSeconds: number): Promise<boolean>;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>(); // key → expiry epoch ms

  async burn(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    this.sweep(now);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, now + ttlSeconds * 1000);
    return true;
  }

  private sweep(now: number): void {
    if (this.seen.size < 10_000) return;
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }
}
