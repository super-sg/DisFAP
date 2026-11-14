#!/usr/bin/env node
/**
 * Demo seed — the minimum tenancy rows the evaluation needs, and nothing more.
 *
 * The control plane refuses to burn a VM for an org with no active
 * subscription (`enforceQuota` → `no_subscription`), and every session row is
 * FK-bound to a `workspace_templates` row, so without these rows the demo
 * cannot even reach `RunInstances`.
 *
 * Idempotent (upsert): safe to re-run. It does NOT touch marketplace listings —
 * those are created by the owner flow (`POST /marketplace/licenses`) so the
 * demo shows a real publish. The dev catalog seed in `server.ts` is separate.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/demo/seed.mjs
 *
 * It reads DATABASE_URL from the environment only. No credentials are printed.
 */

import { PrismaClient } from '@prisma/client';

const ORG_ID = 'org_dev';
const USER_ID = 'usr_dev';
const OWNER_ID = 'usr_owner';
const RENTER_ID = 'usr_renter';
const PLAN_ID = 'plan_demo';
const TZ = { width: 1920, height: 1080, dpi: 96 };

const prisma = new PrismaClient();

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (this script never guesses a connection string)');
  }

  await prisma.org.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'DisFAP Demo Org' },
  });

  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {},
    create: { id: USER_ID, email: 'demo@disfap.local', name: 'DisFAP Demo User' },
  });

  // Two independent demonstration identities. They share the local org so the
  // marketplace's cross-owner listing model and the existing plan/subscription
  // apply to both, but they are distinct users with distinct roles (you can
  // verify ownership scoping with `GET /api/marketplace/licenses/mine`).
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: { name: 'Alex Owner', email: 'owner@disfap.local' },
    create: { id: OWNER_ID, email: 'owner@disfap.local', name: 'Alex Owner' },
  });
  await prisma.user.upsert({
    where: { id: RENTER_ID },
    update: { name: 'Riley Renter', email: 'renter@disfap.local' },
    create: { id: RENTER_ID, email: 'renter@disfap.local', name: 'Riley Renter' },
  });

  // The dev-header authenticator resolves the caller's role from this row and
  // refuses an identity with no membership (401), so it is required.
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: ORG_ID, userId: USER_ID } },
    update: { role: 'owner' },
    create: { orgId: ORG_ID, userId: USER_ID, role: 'owner' },
  });
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: ORG_ID, userId: OWNER_ID } },
    update: { role: 'owner' },
    create: { orgId: ORG_ID, userId: OWNER_ID, role: 'owner' },
  });
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: ORG_ID, userId: RENTER_ID } },
    update: { role: 'member' },
    create: { orgId: ORG_ID, userId: RENTER_ID, role: 'member' },
  });

  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: {
      id: PLAN_ID,
      stripePriceId: 'price_demo_local',
      name: 'Demo (local evaluation)',
      includedSeatHours: 1000,
      overagePriceCents: 10,
      maxConcurrent: 5,
      features: { demo: true },
    },
  });

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  await prisma.subscription.upsert({
    where: { orgId: ORG_ID },
    update: { status: 'active', currentPeriodStart: now, currentPeriodEnd: periodEnd },
    create: {
      orgId: ORG_ID,
      stripeCustomerId: 'cus_demo_local',
      stripeSubscriptionId: 'sub_demo_local',
      planId: PLAN_ID,
      seats: 5,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
  });

  // Linux RDP desktop — the ONLY template the real-AWS evaluation will launch
  // (`requireLinuxRdp` rejects anything else). The broker reads width/height/dpi
  // from `guacParams`; credentials are NEVER stored here.
  await prisma.workspaceTemplate.upsert({
    where: { id: 'tmpl_linux_dev' },
    update: { active: true },
    create: {
      id: 'tmpl_linux_dev',
      orgId: ORG_ID,
      name: 'Ubuntu Desktop (XFCE over xrdp)',
      os: 'linux',
      connectionProtocol: 'rdp',
      guacParams: TZ,
      idleTimeoutS: 900,
      maxSessionS: 7200,
      recordingEnabled: false,
      gpu: false,
      active: true,
    },
  });

  // Kept so the marketplace/Windows path still resolves, but it will NOT launch
  // on the AWS evaluation path (the planner requires a Linux RDP template).
  await prisma.workspaceTemplate.upsert({
    where: { id: 'tmpl_win_rdp' },
    update: { active: true },
    create: {
      id: 'tmpl_win_rdp',
      orgId: ORG_ID,
      name: 'Windows Server 2022 (Standard)',
      os: 'windows',
      connectionProtocol: 'rdp',
      guacParams: TZ,
      idleTimeoutS: 900,
      maxSessionS: 7200,
      recordingEnabled: true,
      gpu: false,
      active: true,
    },
  });

  console.log('demo seed complete:');
  console.log(`  org          ${ORG_ID}`);
  console.log(`  owner        ${OWNER_ID} (role owner)`);
  console.log(`  renter       ${RENTER_ID} (role member)`);
  console.log(`  legacy user  ${USER_ID} (role owner)`);
  console.log(`  plan/sub     ${PLAN_ID} active`);
  console.log('  templates    tmpl_linux_dev, tmpl_win_rdp');
}

main()
  .catch((err) => {
    console.error('demo seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
