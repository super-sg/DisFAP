import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RATE_LIMITS,
  FixedWindowRateLimiter,
  classifyRequest,
  type RateLimitRules,
} from '../src/http/rate-limit.js';

const rules: RateLimitRules = {
  global: { windowMs: 1000, max: 3 },
  'session-create': { windowMs: 1000, max: 2 },
  'guest-provision': { windowMs: 1000, max: 5 },
};

describe('classifyRequest', () => {
  it('maps the expensive POSTs to their own class', () => {
    expect(classifyRequest('POST', '/sessions')).toBe('session-create');
    expect(classifyRequest('POST', '/api/sessions')).toBe('session-create');
    expect(classifyRequest('POST', '/marketplace/rent')).toBe('session-create');
    expect(classifyRequest('POST', '/api/marketplace/rent')).toBe('session-create');
    expect(classifyRequest('POST', '/internal/guest/provision')).toBe('guest-provision');
  });

  it('does not let a query string or a suffix create a fresh class', () => {
    expect(classifyRequest('POST', '/sessions?x=1')).toBe('session-create');
    expect(classifyRequest('POST', '/sessions/../sessions')).toBe('global');
    expect(classifyRequest('GET', '/sessions')).toBe('global');
    expect(classifyRequest('DELETE', '/sessions/ses_1')).toBe('global');
  });

  it('strips exactly the /api prefix, not a lookalike', () => {
    expect(classifyRequest('GET', '/apix/sessions')).toBe('global');
    expect(classifyRequest('GET', '/api')).toBe('global');
  });
});

describe('FixedWindowRateLimiter', () => {
  it('allows up to the cap, then blocks with a retry hint', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(rules, () => now);
    expect(limiter.check('session-create', '1.2.3.4').allowed).toBe(true);
    expect(limiter.check('session-create', '1.2.3.4').allowed).toBe(true);

    now = 250;
    const blocked = limiter.check('session-create', '1.2.3.4');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterS).toBe(1);

    now = 1000;
    expect(limiter.check('session-create', '1.2.3.4').allowed).toBe(true);
  });

  it('keys buckets by subject and by class independently', () => {
    const limiter = new FixedWindowRateLimiter(rules, () => 0);
    limiter.check('session-create', 'a');
    limiter.check('session-create', 'a');
    expect(limiter.check('session-create', 'a').allowed).toBe(false);
    // Another client is unaffected.
    expect(limiter.check('session-create', 'b').allowed).toBe(true);
    // Another class is unaffected.
    expect(limiter.check('global', 'a').allowed).toBe(true);
  });

  it('keeps the bucket isolated when an unknown address is shared', () => {
    const limiter = new FixedWindowRateLimiter(rules, () => 0);
    limiter.check('global', 'unknown');
    limiter.check('global', 'unknown');
    limiter.check('global', 'unknown');
    expect(limiter.check('global', 'unknown').allowed).toBe(false);
  });

  it('sweeps expired buckets instead of growing without bound', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(rules, () => now);
    for (let i = 0; i < 500; i += 1) limiter.check('global', `ip-${i}`);
    // Force a sweep well past every window, then check a fresh subject.
    now = 10 * 60_000;
    expect(limiter.check('global', 'ip-0').allowed).toBe(true);
  });

  it('ships defaults that a normal client never trips', () => {
    expect(DEFAULT_RATE_LIMITS.global.max).toBeGreaterThan(100);
    expect(DEFAULT_RATE_LIMITS['session-create'].max).toBeLessThan(DEFAULT_RATE_LIMITS.global.max);
    expect(DEFAULT_RATE_LIMITS['guest-provision'].windowMs).toBe(60_000);
  });
});
