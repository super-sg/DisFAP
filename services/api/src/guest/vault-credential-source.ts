/**
 * Vault-backed session-credential source for guest provisioning.
 *
 * The session credential is already staged in Vault at claim time (the broker
 * consumes it via a single-use wrap token at connect). Guest provisioning
 * re-reads the SAME path with the API's own token — a server-side read that
 * does not consume the broker's wrap token and keeps Vault the single
 * authoritative store for session credentials (no second in-memory copy).
 *
 * Returns null when the path is absent/expired or has no username, so the
 * caller fails closed rather than delivering a partial credential.
 */

import type { VaultClient } from '../vault/vault-client.js';
import type { GuestCredentialSource } from './guest-provisioning.js';

export class VaultGuestCredentialSource implements GuestCredentialSource {
  constructor(
    private readonly vault: VaultClient,
    private readonly pathFor: (sessionId: string) => string,
  ) {}

  async read(sessionId: string): Promise<{ username: string; password?: string; privateKey?: string } | null> {
    const data = await this.vault.read(this.pathFor(sessionId));
    if (!data) return null;
    const username = data['username'];
    if (typeof username !== 'string' || username === '') return null;
    const out: { username: string; password?: string; privateKey?: string } = { username };
    if (typeof data['password'] === 'string') out.password = data['password'];
    if (typeof data['private_key'] === 'string') out.privateKey = data['private_key'];
    return out;
  }
}
