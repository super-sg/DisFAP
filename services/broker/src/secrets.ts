/**
 * Best-effort erasure of session credential material.
 *
 * The spec requires that the gateway "wipe the credential data from its memory"
 * once it has injected it into the RDP/VNC handshake. JavaScript strings are
 * immutable, so a plaintext password **cannot** be zeroed in place; the honest
 * guarantee is that we drop every reference we control the instant it is no
 * longer needed, which bounds the window in which it is reachable, and we
 * overwrite in place the object we were handed (including the copy an in-process
 * provider still holds).
 *
 * Buffers can be truly overwritten; `docs/security.md` states this distinction
 * rather than claiming physical erasure.
 */

import type { SessionCredential } from './protocol/adapter.js';

/**
 * guacd connection parameters that carry secret material. `passphrase` and
 * `private-key` are for SSH/cert-based targets; they are scrubbed even when the
 * current protocol did not set them.
 */
const GUAC_SECRET_PARAMS = ['username', 'password', 'private-key', 'passphrase', 'domain'] as const;

/** Overwrite the credential fields in place (visible to every holder of the object). */
export function scrubCredential(credential: SessionCredential): void {
  credential.username = '';
  if (credential.password !== undefined) credential.password = '';
  if (credential.privateKey !== undefined) credential.privateKey = '';
}

/** Overwrite the secret-bearing guacd parameters before the map goes out of scope. */
export function scrubGuacParams(params: Record<string, string>): void {
  for (const name of GUAC_SECRET_PARAMS) {
    if (name in params) params[name] = '';
  }
}
