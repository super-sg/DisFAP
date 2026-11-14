/**
 * Identity and membership: mapping a verified external identity to an internal
 * user, and resolving the role a caller actually holds in an org.
 *
 * Privilege is data, never a request header — `roleOf` is the only source of a
 * role, and it reads `org_members`.
 */

import type { PrismaClient } from '@prisma/client';

import type { IdentityRepo, MemberResolution, MembershipRepo } from '../../ports.js';
import type { PrincipalRole } from '../../auth/authenticator.js';
import type { IdentityProvisioningStore } from '../../auth/identity-provisioning.js';

export class PrismaMembershipRepo implements MembershipRepo {
  constructor(private readonly db: PrismaClient) {}

  async roleOf(orgId: string, userId: string): Promise<PrincipalRole | null> {
    const member = await this.db.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    return (member?.role as PrincipalRole | undefined) ?? null;
  }

  async resolveMembership(userId: string, orgHint?: string): Promise<MemberResolution | null> {
    // A token's org hint only selects among the memberships that actually
    // exist server-side; it never grants one.
    if (orgHint !== undefined) {
      const role = await this.roleOf(orgHint, userId);
      return role ? { orgId: orgHint, role } : null;
    }
    const memberships = await this.db.orgMember.findMany({
      where: { userId },
      select: { orgId: true, role: true },
    });
    if (memberships.length !== 1) return null; // none, or ambiguous without a hint
    const only = memberships[0]!;
    return { orgId: only.orgId, role: only.role as PrincipalRole };
  }
}

export class PrismaIdentityRepo implements IdentityRepo {
  constructor(private readonly db: PrismaClient) {}

  async resolve(issuer: string, subject: string): Promise<string | null> {
    const row = await this.db.externalIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }
}

/**
 * Operator-only store for provisioning `external_identities` (see
 * `auth/identity-provisioning.ts` and `cli/provision-identity.ts`). Not wired
 * into any HTTP route.
 */
export class PrismaIdentityProvisioningStore implements IdentityProvisioningStore {
  constructor(private readonly db: PrismaClient) {}

  async findUserId(issuer: string, subject: string): Promise<string | null> {
    const row = await this.db.externalIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  async userExists(userId: string): Promise<boolean> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    return user !== null;
  }

  async create(input: { issuer: string; subject: string; userId: string; email?: string }): Promise<void> {
    await this.db.externalIdentity.create({
      data: {
        issuer: input.issuer,
        subject: input.subject,
        userId: input.userId,
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
    });
  }

  async reassign(issuer: string, subject: string, userId: string): Promise<void> {
    await this.db.externalIdentity.update({
      where: { issuer_subject: { issuer, subject } },
      data: { userId },
    });
  }
}
