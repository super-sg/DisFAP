/**
 * Provisioning package — the exact, versioned contract between the control
 * plane and the guest provisioning unit (`infra/packer/provision/guest/
 * dfap-provision.sh`). Both sides implement the SAME strict validation; the
 * shell is a mirror of `validateProvisioningPackage` below (see the script's
 * `--self-test` mode, which pins the two against identical fixtures).
 *
 * The package is delivered ONCE over TLS to a guest whose instance identity has
 * been cryptographically verified (see `instance-identity.ts`) and whose
 * instance→session binding was enforced server-side. It carries the login
 * material the guest materializes into a least-privilege session account.
 *
 * RULES
 *  - `v` is mandatory; an unknown version is rejected, never best-effort parsed.
 *  - Every binding field is mandatory and is re-checked by the guest against
 *    what it independently knows locally (its own instance id, image id, and
 *    the `dfap:session_id` instance tag) — the guest does not take the control
 *    plane's word for its own identity.
 *  - `osPassword` is REQUIRED for a Linux RDP session (PAM needs a password;
 *    sshd is disabled). It is never logged, never placed in argv, and never
 *    written anywhere except through the account-creation path.
 */

import { createHash } from 'node:crypto';

export const PROVISIONING_PACKAGE_VERSION = 1 as const;

/** Minimum accepted length for a provisioned account password. */
export const MIN_OS_PASSWORD_LENGTH = 16;

/** Conservative, portable POSIX account-name grammar. */
export const OS_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** App/profile identifier the image maps to a pre-installed application. */
export const APP_PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ProvisioningPackage {
  v: typeof PROVISIONING_PACKAGE_VERSION;
  sessionId: string;
  /** Marketplace license this session rented, or null for a base session. */
  licenseId: string | null;
  orgId: string;
  templateId: string;
  /** EC2 instance id the credential is authorized for. */
  instanceId: string;
  /** AMI the credential is authorized for. */
  imageId: string;
  /** Least-privilege OS account to create/refresh. */
  osUsername: string;
  /** Account password. Never logged, never on argv. */
  osPassword: string;
  /**
   * Application/profile identity the license maps to (e.g. "matlab"), or null
   * for a plain desktop. The image resolves this to a pre-installed app; the
   * rentee never receives the owner's application secret except as the login
   * identity it cannot read back (the OS stores only a hash).
   */
  appProfile: string | null;
  issuedAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
}

export interface ProvisioningPackageInput {
  sessionId: string;
  licenseId: string | null;
  orgId: string;
  templateId: string;
  instanceId: string;
  imageId: string;
  osUsername: string;
  osPassword: string;
  appProfile: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

export class ProvisioningPackageError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningPackageError';
  }
}

/**
 * Build a package from already-authorized inputs. Rejects at build time if the
 * inputs could not produce a valid package (defence against a bug upstream
 * emitting something the guest would have to reject at boot).
 */
export function buildProvisioningPackage(input: ProvisioningPackageInput): ProvisioningPackage {
  const pkg: ProvisioningPackage = {
    v: PROVISIONING_PACKAGE_VERSION,
    sessionId: input.sessionId,
    licenseId: input.licenseId,
    orgId: input.orgId,
    templateId: input.templateId,
    instanceId: input.instanceId,
    imageId: input.imageId,
    osUsername: input.osUsername,
    osPassword: input.osPassword,
    appProfile: input.appProfile,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
  // Structural validation only: expiry is compared against `issuedAt` here (a
  // package is well-formed iff it expires after it was issued). The guest, and
  // the service at delivery time, re-check expiry against the real clock.
  const validation = validateProvisioningPackage(pkg, undefined, input.issuedAt);
  if (!validation.ok) throw new ProvisioningPackageError(validation.reason);
  return pkg;
}

export interface ExpectedPackageBinding {
  sessionId: string;
  instanceId: string;
  imageId: string;
}

export type PackageValidation =
  | { ok: true; pkg: ProvisioningPackage }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

/**
 * Strict validation of a received package. When `expected` is supplied, the
 * binding fields must match it — this is what lets the guest independently
 * cross-check the control plane against what it knows locally, and what lets
 * the API-side tests assert wrong-session/wrong-instance/wrong-image rejection.
 *
 * `now` is injectable so expiry is testable.
 */
export function validateProvisioningPackage(
  raw: unknown,
  expected?: ExpectedPackageBinding,
  now: Date = new Date(),
): PackageValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'package is not an object' };
  if (raw['v'] !== PROVISIONING_PACKAGE_VERSION) return { ok: false, reason: 'unsupported package version' };

  for (const field of ['sessionId', 'orgId', 'templateId', 'instanceId', 'imageId', 'osUsername', 'osPassword'] as const) {
    if (!nonEmptyString(raw[field])) return { ok: false, reason: `package missing ${field}` };
  }
  if (raw['licenseId'] !== null && !nonEmptyString(raw['licenseId'])) {
    return { ok: false, reason: 'package licenseId must be a string or null' };
  }
  if (raw['appProfile'] !== null && !nonEmptyString(raw['appProfile'])) {
    return { ok: false, reason: 'package appProfile must be a string or null' };
  }

  const osUsername = raw['osUsername'] as string;
  if (!OS_USERNAME_RE.test(osUsername)) return { ok: false, reason: 'package osUsername is not a valid POSIX account name' };
  const osPassword = raw['osPassword'] as string;
  if (osPassword.length < MIN_OS_PASSWORD_LENGTH) return { ok: false, reason: 'package osPassword is too short' };
  if (raw['appProfile'] !== null && !APP_PROFILE_RE.test(raw['appProfile'] as string)) {
    return { ok: false, reason: 'package appProfile is invalid' };
  }

  if (!nonEmptyString(raw['issuedAt']) || !nonEmptyString(raw['expiresAt'])) {
    return { ok: false, reason: 'package timestamps are missing' };
  }
  const issuedAt = new Date(raw['issuedAt'] as string);
  const expiresAt = new Date(raw['expiresAt'] as string);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: 'package timestamps are invalid' };
  }
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'package has expired' };

  if (expected) {
    if (raw['sessionId'] !== expected.sessionId) return { ok: false, reason: 'package session binding mismatch' };
    if (raw['instanceId'] !== expected.instanceId) return { ok: false, reason: 'package instance binding mismatch' };
    if (raw['imageId'] !== expected.imageId) return { ok: false, reason: 'package image binding mismatch' };
  }

  return { ok: true, pkg: raw as unknown as ProvisioningPackage };
}

/**
 * A non-secret fingerprint of the credential a guest materialized. The guest
 * stores this (never the credential) so a re-delivery for the same session can
 * be recognised as idempotent, and a *different* credential for the same
 * session can be distinguished from a replay. This is a hash, not the secret.
 */
export function credentialFingerprint(packageOrCredential: { osUsername: string; osPassword: string }): string {
  return createHash('sha256').update(`${packageOrCredential.osUsername}\u0000${packageOrCredential.osPassword}`).digest('hex');
}
