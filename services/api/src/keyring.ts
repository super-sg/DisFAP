/**
 * Build the HMAC `Keyring` the broker's token minter expects, from the same
 * base64 key material the config parsed. This is NOT a reimplementation of the
 * token scheme — it only assembles the key ring; `mintConnectToken` /
 * `verifyConnectToken` (imported from `@disfap/broker`) own all HMAC logic.
 */

import type { Keyring } from '@disfap/broker/src/session-token.js';

export interface KeyringSource {
  signingKeys: Record<string, string>;
  signingKid: string;
}

export function buildKeyring(src: KeyringSource): Keyring {
  const keys = new Map<string, Buffer>();
  for (const [kid, b64] of Object.entries(src.signingKeys)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length < 32) throw new Error(`signing key ${kid} is shorter than 32 bytes`);
    keys.set(kid, key);
  }
  if (!keys.has(src.signingKid)) throw new Error(`signing kid ${src.signingKid} not in key ring`);
  return { keys, signingKid: src.signingKid };
}
