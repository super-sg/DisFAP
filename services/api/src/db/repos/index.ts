/**
 * Barrel for the Prisma repository adapters.
 *
 * This is the only module (besides `db/client.ts`) that reaches the generated
 * Prisma client, so the rest of the control plane — and every unit test — stays
 * client-free and fast.
 *
 * Requires `npm run prisma:generate` before type-check / run.
 */

export { ACTIVE_STATES, num, toSessionRecord } from './shared.js';
export { PrismaSessionRepo, PrismaSessionConnectStore } from './session.js';
export { PrismaMembershipRepo, PrismaIdentityRepo, PrismaIdentityProvisioningStore } from './identity.js';
export { PrismaEventRecorder, PrismaAuditRecorder } from './audit.js';
export {
  PrismaTemplateRepo,
  PrismaInstanceRepo,
  PrismaGuestBindingStore,
  PrismaReaperDb,
} from './pool.js';
export { PrismaQuotaStore, PrismaUsageStore, PrismaStripeEventStore } from './billing.js';
