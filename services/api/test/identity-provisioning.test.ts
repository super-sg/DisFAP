/**
 * Identity provisioning — the operator/admin mapping workflow.
 *
 * These tests pin the fail-safe invariants: the key is the exact
 * (issuer, subject) pair, the internal user must exist, the operation is
 * idempotent, and an existing mapping is never silently repointed.
 */

import { describe, expect, it } from 'vitest';

import { ProvisioningError, provisionIdentity, type IdentityProvisioningStore } from '../src/auth/identity-provisioning.js';

class InMemoryProvisioningStore implements IdentityProvisioningStore {
  readonly rows = new Map<string, { issuer: string; subject: string; userId: string; email?: string }>();
  readonly users = new Set<string>();

  private key(issuer: string, subject: string): string {
    return `${issuer}|${subject}`;
  }

  async findUserId(issuer: string, subject: string): Promise<string | null> {
    return this.rows.get(this.key(issuer, subject))?.userId ?? null;
  }
  async userExists(userId: string): Promise<boolean> {
    return this.users.has(userId);
  }
  async create(input: { issuer: string; subject: string; userId: string; email?: string }): Promise<void> {
    this.rows.set(this.key(input.issuer, input.subject), { ...input });
  }
  async reassign(issuer: string, subject: string, userId: string): Promise<void> {
    const row = this.rows.get(this.key(issuer, subject));
    if (!row) throw new Error('reassign on missing row');
    row.userId = userId;
  }
}

const ISSUER = 'https://login.example.com/';

function storeWithUsers(...ids: string[]): InMemoryProvisioningStore {
  const s = new InMemoryProvisioningStore();
  for (const id of ids) s.users.add(id);
  return s;
}

describe('provisionIdentity — happy path & idempotency', () => {
  it('creates a mapping for an existing user', async () => {
    const store = storeWithUsers('usr_1');
    const action = await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    expect(action).toBe('created');
    expect(await store.findUserId(ISSUER, 'sub-a')).toBe('usr_1');
  });

  it('stores an informational email without using it as a key', async () => {
    const store = storeWithUsers('usr_1');
    await provisionIdentity(store, {
      issuer: ISSUER,
      subject: 'sub-a',
      userId: 'usr_1',
      email: 'a@example.com',
    });
    expect(store.rows.get(`${ISSUER}|sub-a`)?.email).toBe('a@example.com');
    // The lookup key is (issuer, subject) only — email does not resolve.
    expect(await store.findUserId(ISSUER, 'a@example.com')).toBeNull();
  });

  it('is idempotent for the same mapping', async () => {
    const store = storeWithUsers('usr_1');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    const again = await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    expect(again).toBe('unchanged');
    expect(store.rows.size).toBe(1);
  });
});

describe('provisionIdentity — refuses unsafe operations', () => {
  it('rejects a nonexistent internal user and creates nothing', async () => {
    const store = storeWithUsers();
    await expect(provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_missing' })).rejects.toBeInstanceOf(
      ProvisioningError,
    );
    expect(store.rows.size).toBe(0);
  });

  it('refuses to reassign an existing mapping to another user without the explicit opt-in', async () => {
    const store = storeWithUsers('usr_1', 'usr_2');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    await expect(
      provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_2' }),
    ).rejects.toThrow(/refusing to reassign/);
    // Unchanged.
    expect(await store.findUserId(ISSUER, 'sub-a')).toBe('usr_1');
  });

  it('reassigns only when reassign is explicitly requested', async () => {
    const store = storeWithUsers('usr_1', 'usr_2');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    const action = await provisionIdentity(store, {
      issuer: ISSUER,
      subject: 'sub-a',
      userId: 'usr_2',
      reassign: true,
    });
    expect(action).toBe('reassigned');
    expect(await store.findUserId(ISSUER, 'sub-a')).toBe('usr_2');
  });

  it('rejects an invalid issuer and empty identifiers', async () => {
    const store = storeWithUsers('usr_1');
    await expect(provisionIdentity(store, { issuer: 'not-a-url', subject: 's', userId: 'usr_1' })).rejects.toBeInstanceOf(
      ProvisioningError,
    );
    await expect(provisionIdentity(store, { issuer: ISSUER, subject: '  ', userId: 'usr_1' })).rejects.toBeInstanceOf(
      ProvisioningError,
    );
    await expect(provisionIdentity(store, { issuer: ISSUER, subject: 's', userId: '' })).rejects.toBeInstanceOf(
      ProvisioningError,
    );
  });
});

describe('provisionIdentity — exact-match keys', () => {
  it('treats the same subject under a different issuer as a distinct identity', async () => {
    const store = storeWithUsers('usr_1', 'usr_2');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    await provisionIdentity(store, { issuer: 'https://other.example.com/', subject: 'sub-a', userId: 'usr_2' });

    expect(await store.findUserId(ISSUER, 'sub-a')).toBe('usr_1');
    expect(await store.findUserId('https://other.example.com/', 'sub-a')).toBe('usr_2');
  });

  it('does not normalize the issuer (exact string match)', async () => {
    const store = storeWithUsers('usr_1');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    // A trailing-slash variation is a different issuer, not a match.
    expect(await store.findUserId('https://login.example.com', 'sub-a')).toBeNull();
  });

  it('treats different subjects as distinct identities', async () => {
    const store = storeWithUsers('usr_1', 'usr_2');
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-a', userId: 'usr_1' });
    await provisionIdentity(store, { issuer: ISSUER, subject: 'sub-b', userId: 'usr_2' });
    expect(await store.findUserId(ISSUER, 'sub-a')).toBe('usr_1');
    expect(await store.findUserId(ISSUER, 'sub-b')).toBe('usr_2');
  });
});
