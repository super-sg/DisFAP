/**
 * Operator-only provisioning of external OIDC identities.
 *
 * This is the administrative half of the identity model: a verified token's
 * `(issuer, subject)` must already be mapped to an internal DisFAP user before
 * the identity can authenticate (see `auth/oidc.ts`). There is deliberately NO
 * just-in-time provisioning from a token.
 *
 * Invariants enforced here:
 *  - the identity key is the exact `(issuer, subject)` pair — never email;
 *  - the internal user must already exist (no account/org auto-creation);
 *  - the operation is idempotent (re-provisioning the same mapping is a no-op);
 *  - an existing mapping is never repointed to another user unless the caller
 *    passes an explicit `reassign` opt-in (guards against a typo silently moving
 *    someone else's login);
 *  - the issuer is matched exactly (an absolute http(s) URL, unmodified).
 *
 * The pure logic lives here so it is unit-testable; the Prisma adapter lives in
 * `db/prisma-repos.ts` and the CLI in `cli/provision-identity.ts`.
 */

export interface IdentityProvisioningStore {
  /** The internal user id currently mapped to (issuer, subject), or null. */
  findUserId(issuer: string, subject: string): Promise<string | null>;
  /** Whether an internal user with this id exists. */
  userExists(userId: string): Promise<boolean>;
  /** Insert a new (issuer, subject) → user mapping. */
  create(input: { issuer: string; subject: string; userId: string; email?: string }): Promise<void>;
  /** Repoint an existing (issuer, subject) mapping to a different user. */
  reassign(issuer: string, subject: string, userId: string): Promise<void>;
}

export type ProvisionAction = 'created' | 'unchanged' | 'reassigned';

export interface ProvisionIdentityInput {
  issuer: string;
  subject: string;
  userId: string;
  /** Informational snapshot only; never part of the identity key. */
  email?: string;
  /** Explicit, deliberate opt-in to repoint an existing mapping. */
  reassign?: boolean;
}

/** A provisioning failure the operator can act on (message is non-secret). */
export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

function exactIssuer(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProvisioningError(`--issuer must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProvisioningError('--issuer must be an http(s) URL');
  }
  if (parsed.search || parsed.hash) {
    throw new ProvisioningError('--issuer must not carry a query or fragment');
  }
  // Return the trimmed value unchanged: issuer matching is exact.
  return trimmed;
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new ProvisioningError(`${name} must not be empty`);
  return trimmed;
}

/**
 * Map an external `(issuer, subject)` to an existing internal user.
 * Returns the action taken. Throws `ProvisioningError` on validation failure.
 */
export async function provisionIdentity(
  store: IdentityProvisioningStore,
  input: ProvisionIdentityInput,
): Promise<ProvisionAction> {
  const issuer = exactIssuer(input.issuer);
  const subject = required(input.subject, 'subject');
  const userId = required(input.userId, 'userId');

  if (!(await store.userExists(userId))) {
    throw new ProvisioningError(`no such DisFAP user: ${userId}`);
  }

  const existing = await store.findUserId(issuer, subject);
  if (existing === null) {
    await store.create({
      issuer,
      subject,
      userId,
      ...(input.email !== undefined && input.email.trim() !== '' ? { email: input.email.trim() } : {}),
    });
    return 'created';
  }
  if (existing === userId) return 'unchanged';

  if (input.reassign !== true) {
    throw new ProvisioningError(
      `identity (${issuer}, ${subject}) is already mapped to ${existing}; ` +
        `refusing to reassign to ${userId} (pass --reassign to override)`,
    );
  }
  await store.reassign(issuer, subject, userId);
  return 'reassigned';
}
