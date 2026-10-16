/**
 * VaultCredentialProvider — the control-plane implementation of the broker's
 * `CredentialProvider` interface. The broker calls `fetch(sid, wrapToken)` once,
 * at connect time; we unwrap the single-use Vault token and hand back the
 * credential. A second call fails (the wrap token is burned), which is the
 * read-once tamper signal the broker relies on.
 *
 * This is the last place the credential exists on the server before it is fed
 * to the RDP/VNC backend as pixels. It never touches Postgres or a log.
 */

import type { CredentialProvider } from '@disfap/broker/src/vault/credential-provider.js';
import type { SessionCredential } from '@disfap/broker/src/protocol/adapter.js';

import type { VaultClient } from '../vault/vault-client.js';

export class VaultCredentialProvider implements CredentialProvider {
  constructor(private readonly vault: VaultClient) {}

  async fetch(_sid: string, wrapToken: string): Promise<SessionCredential> {
    // Single-use unwrap; throws if already consumed/expired/unknown.
    const { data } = await this.vault.unwrap(wrapToken);
    const username = data['username'];
    if (!username) throw new Error('vault credential missing username');

    const cred: SessionCredential = { username };
    if (data['password'] !== undefined) cred.password = data['password'];
    if (data['private_key'] !== undefined) cred.privateKey = data['private_key'];
    return cred;
  }
}
