/**
 * CredentialIssuer — stages the per-session VM credential in Vault at claim
 * time and returns a single-use response-wrapped token for the broker.
 *
 * The credential is minted here (control plane) with a lifetime ≈ the
 * session's, written to `secret/sessions/{sid}/rdp`, and then only ever leaves
 * Vault as pixels' worth of RDP — never to the DB, never to a log, never to
 * the browser (ADR-002/004). The plaintext credential exists in this process
 * only for the duration of `issue()`.
 */

import { randomBytes } from 'node:crypto';
import type { VaultClient } from '../vault/vault-client.js';

/** Secret material for a session VM login. Never persisted outside Vault. */
export interface SessionCredentialMaterial {
  username: string;
  password?: string;
  privateKey?: string;
}

export interface IssuedCredential {
  /** Single-use response-wrapped token the broker unwraps at connect time. */
  wrapToken: string;
  /** Vault KV path the secret lives at (safe to persist — it's a pointer). */
  vaultPath: string;
  expiresAt: Date;
}

export interface CredentialIssuer {
  issue(sid: string, credential: SessionCredentialMaterial, ttlSeconds: number): Promise<IssuedCredential>;
  /** Best-effort revoke on session teardown. */
  revoke(sid: string): Promise<void>;
  /** Canonical Vault path for a session's credential. */
  pathFor(sid: string): string;
}

/** `secret/sessions/{sid}/rdp` — one credential per session, burned on end. */
function sessionRdpPath(sid: string): string {
  return `sessions/${sid}/rdp`;
}

/**
 * Vault-backed issuer. With a `FakeVaultClient` this is the Phase-0/test path;
 * with an `HttpVaultClient` it is the production path. Behaviour — write-once,
 * wrap, single-use unwrap — is identical either way, which is the whole point
 * of the seam.
 */
export class VaultCredentialIssuer implements CredentialIssuer {
  constructor(private readonly vault: VaultClient) {}

  pathFor(sid: string): string {
    return sessionRdpPath(sid);
  }

  async issue(sid: string, credential: SessionCredentialMaterial, ttlSeconds: number): Promise<IssuedCredential> {
    const path = this.pathFor(sid);
    // Flatten to string map for KV; omit undefined fields so we never write
    // an empty "password" that could be mistaken for a real value.
    const data: Record<string, string> = { username: credential.username };
    if (credential.password !== undefined) data['password'] = credential.password;
    if (credential.privateKey !== undefined) data['private_key'] = credential.privateKey;

    const wrapped = await this.vault.writeWrappedSecret(path, data, ttlSeconds);
    return { wrapToken: wrapped.wrapToken, vaultPath: path, expiresAt: wrapped.expiresAt };
  }

  async revoke(sid: string): Promise<void> {
    await this.vault.revoke(this.pathFor(sid));
  }
}

/**
 * FakeCredentialIssuer — the same logic wired to a caller-supplied
 * `FakeVaultClient`, exported under the name tests reference. Kept as a distinct
 * class so test wiring reads clearly and never accidentally hits real Vault.
 */
export class FakeCredentialIssuer extends VaultCredentialIssuer {}

/** Generate a strong ephemeral VM credential (lifetime ≈ one session). */
export function generateSessionCredential(username = 'dfap-session'): SessionCredentialMaterial {
  // 24 random bytes -> 32-char base64url password. Never logged, never stored.
  return { username, password: randomBytes(24).toString('base64url') };
}
