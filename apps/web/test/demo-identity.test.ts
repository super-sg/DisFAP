import { describe, expect, it } from 'vitest';

import {
  DEMO_IDENTITIES,
  demoAuthEnabled,
  demoRoleFromSearch,
} from '../src/auth/DemoIdentityGate.js';

describe('local demo identity gate', () => {
  it('maps only the two explicit demo roles from the URL', () => {
    expect(demoRoleFromSearch('?as=owner')).toBe('owner');
    expect(demoRoleFromSearch('?as=renter')).toBe('renter');
    expect(demoRoleFromSearch('?as=admin')).toBeNull();
    expect(demoRoleFromSearch('')).toBeNull();
  });

  it('sends distinct seeded principals for owner and renter', () => {
    expect(DEMO_IDENTITIES.owner.userId).not.toBe(DEMO_IDENTITIES.renter.userId);
    expect(DEMO_IDENTITIES.owner.role).toBe('owner');
    expect(DEMO_IDENTITIES.renter.role).toBe('member');
    expect(DEMO_IDENTITIES.owner.orgId).toBe(DEMO_IDENTITIES.renter.orgId);
  });

  it('is enabled only for a dev build on loopback', () => {
    expect(demoAuthEnabled({ DEV: true }, { hostname: 'localhost' })).toBe(true);
    expect(demoAuthEnabled({ DEV: true }, { hostname: '127.0.0.1' })).toBe(true);
    expect(demoAuthEnabled({ DEV: true }, { hostname: 'disfap.example' })).toBe(false);
    expect(demoAuthEnabled({ DEV: false }, { hostname: 'localhost' })).toBe(false);
  });
});
