/**
 * Durable credential-key storage (audit M7, part A).
 *
 * Turns configuration into key material for the Layer-2 credential provider.
 * There is deliberately **no** implicit ephemeral fallback: a deployment either
 * names a durable source (a PEM file or an inline PEM) or startup fails. The
 * only exception is an explicit dev default file, and only when the process is
 * not production.
 *
 * Supported sources:
 *  - `DFAP_CREDENTIAL_KEY_FILE` — a PKCS#8 PEM file. Created (0600, inside a
 *    0700 directory) on first use if absent, so a dev machine keeps the same key
 *    across restarts. Never committed (`.gitignore` covers `*.pem` / `.dfap/`).
 *  - `DFAP_CREDENTIAL_KEY_PEM`  — base64 of the same PEM, for deploys that
 *    inject secrets through the environment rather than a file.
 *  - `DFAP_CREDENTIAL_KEY_RETIRED_PEMS` — comma-separated base64 PEMs of
 *    previous keys, kept for DECRYPTION ONLY during rotation.
 *
 * The file is the *private* key; the public key and its id are derived. Key
 * material never appears in a payload, response, or log.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  DEFAULT_MIN_MODULUS_BITS,
  DEFAULT_MODULUS_BITS,
  RotatingCredentialHsm,
  SoftwareHsm,
  generateCredentialKeyMaterial,
  type CredentialKeyMaterial,
  type HsmService,
} from './hsm-rsa.js';

/** Credential-key settings parsed from the environment (see `config.ts`). */
export interface CredentialKeyConfig {
  /** Path to the active key's PKCS#8 PEM (private). Created in dev if absent. */
  file?: string;
  /** base64 of the active key's PKCS#8 PEM. */
  pem?: string;
  /** base64 PKCS#8 PEMs of retired keys (decrypt-only). */
  retiredPems: readonly string[];
}

/** Derive a full key material (public + id) from a single private PKCS#8 PEM. */
export function materialFromPrivatePem(
  privateKeyPem: string,
  opts: { minModulusBits?: number } = {},
): CredentialKeyMaterial {
  let publicKeyPem: string;
  try {
    publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString();
  } catch {
    throw new Error('credential key PEM is not a valid PKCS#8 private key');
  }
  return {
    publicKeyPem,
    privateKeyPem,
    ...(opts.minModulusBits !== undefined ? { minModulusBits: opts.minModulusBits } : {}),
  };
}

function decodeBase64Pem(b64: string): string {
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    throw new Error('credential key env must be base64 of a PEM private key');
  }
  return pem;
}

/**
 * Read (or create) a key file. Creation is race-safe (`wx`): if two processes
 * start together, one writes and the other reads the winner's key.
 */
export function loadOrCreateCredentialKeyFile(
  path: string,
  opts: { bits?: number; minModulusBits?: number } = {},
): CredentialKeyMaterial {
  let existing: string | null = null;
  try {
    existing = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing === null) {
    const { privateKeyPem } = generateCredentialKeyMaterial(opts.bits ?? DEFAULT_MODULUS_BITS);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, privateKeyPem, { mode: 0o600, flag: 'wx' });
      existing = privateKeyPem;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another process won the race — use its key.
      existing = readFileSync(path, 'utf8');
    }
  }

  // Never operate on a world-readable private key.
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    // Best effort; validation below still refuses bad key material.
  }

  return materialFromPrivatePem(existing, opts);
}

/**
 * Build the credential-key provider from config. Throws when no durable source
 * is available (which is fatal in production) — this is the fail-closed edge
 * that prevents a silent ephemeral key from ever serving real ciphertext.
 */
export function createCredentialHsm(
  config: CredentialKeyConfig | undefined,
  env: { production: boolean; devDefaultFile?: string; minModulusBits?: number },
): HsmService {
  const opts: { bits?: number; minModulusBits?: number } = {};
  const minModulusBits = env.minModulusBits ?? DEFAULT_MIN_MODULUS_BITS;
  opts.minModulusBits = minModulusBits;

  let active: CredentialKeyMaterial;
  if (config?.pem) {
    active = materialFromPrivatePem(decodeBase64Pem(config.pem), opts);
  } else if (config?.file) {
    active = loadOrCreateCredentialKeyFile(config.file, opts);
  } else if (env.devDefaultFile && !env.production) {
    active = loadOrCreateCredentialKeyFile(env.devDefaultFile, opts);
  } else {
    throw new Error(
      'no durable credential key configured: set DFAP_CREDENTIAL_KEY_FILE or ' +
        'DFAP_CREDENTIAL_KEY_PEM (required in production; refusing an ephemeral key)',
    );
  }

  const retired = (config?.retiredPems ?? []).map((b64) => materialFromPrivatePem(decodeBase64Pem(b64), opts));
  return retired.length > 0 ? new RotatingCredentialHsm(active, retired) : new SoftwareHsm(active);
}
