/**
 * A small, dependency-free fixed-window rate limiter.
 *
 * Scope, stated honestly: this is an **in-process abuse brake**, not a
 * distributed quota. It stops a single client (or a single misbehaving script)
 * from hammering the expensive paths — creating sessions, renting licenses, and
 * the unauthenticated guest-provisioning endpoint — and it bounds the damage a
 * credential-stuffing loop can do before it has to slow down. A multi-node
 * deployment needs a shared counter (Redis `INCR`+`EXPIRE`); the limiter is an
 * interface so that swap stays local to this file.
 *
 * Keys are `<class>|<subject>`, where the subject is the caller's IP. Requests
 * are classified by method + path (query string and `/api` prefix ignored) so an
 * attacker cannot mint fresh buckets by appending junk to the URL.
 */

export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Allowed requests per key per window. */
  max: number;
}

export type RateLimitClass = 'global' | 'session-create' | 'guest-provision';

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets — sent as `Retry-After` on a 429. */
  retryAfterS: number;
  /** The rule's ceiling, for diagnostics/tests (never caller-controlled). */
  limit: number;
}

export type RateLimitRules = Record<RateLimitClass, RateLimitRule>;

/**
 * Defaults chosen so normal use never sees a 429:
 *  - global: 300/min per IP — a page load is a handful of calls.
 *  - session-create: 12/min per IP — a human cannot start more than that, and a
 *    loop cannot drain the account's quota in seconds.
 *  - guest-provision: 30/min per IP — a booting guest retries a few times.
 */
export const DEFAULT_RATE_LIMITS: RateLimitRules = {
  global: { windowMs: 60_000, max: 300 },
  'session-create': { windowMs: 60_000, max: 12 },
  'guest-provision': { windowMs: 60_000, max: 30 },
};

interface Bucket {
  count: number;
  resetAtMs: number;
}

/** How often expired buckets are swept, at most. */
const SWEEP_INTERVAL_MS = 60_000;

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepMs = 0;

  constructor(
    private readonly rules: RateLimitRules = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(cls: RateLimitClass, subject: string): RateLimitDecision {
    const rule = this.rules[cls];
    const now = this.now();
    this.sweep(now);

    const key = `${cls}|${subject}`;
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= now) {
      this.buckets.set(key, { count: 1, resetAtMs: now + rule.windowMs });
      return { allowed: true, retryAfterS: 0, limit: rule.max };
    }
    if (existing.count >= rule.max) {
      return {
        allowed: false,
        retryAfterS: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)),
        limit: rule.max,
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterS: 0, limit: rule.max };
  }

  /** Drop expired buckets so a long-lived process cannot grow unbounded. */
  private sweep(now: number): void {
    if (now - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Classify a request for limiting. Only method + path matter: parameters and
 * query strings must not be able to create new buckets.
 */
export function classifyRequest(method: string, url: string): RateLimitClass {
  const path = (url.split('?')[0] ?? '').replace(/^\/api(?=\/|$)/, '') || '/';
  const verb = method.toUpperCase();

  if (verb === 'POST') {
    if (path === '/sessions') return 'session-create';
    if (path === '/marketplace/rent') return 'session-create';
    if (path === '/internal/guest/provision') return 'guest-provision';
  }
  return 'global';
}

/**
 * The subject a bucket is keyed by. `req.ip` is the client address as resolved
 * by Fastify (`trustProxy` is on only because the API is reachable exclusively
 * through the edge proxy, which overwrites `X-Forwarded-For`).
 */
export function rateLimitSubject(ip: string | undefined): string {
  // Unknown address still gets one shared bucket rather than bypassing the cap.
  return ip && ip !== '' ? ip : 'unknown';
}
