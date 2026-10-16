/**
 * Composition root. Loads config (fail-fast), constructs concrete adapters
 * (Prisma, cloud, Vault, Stripe), wires the service functions the HTTP layer
 * calls, starts the reaper loop, and listens.
 *
 * Also starts the broker **in-process**: the broker requires a SessionResolver
 * + CredentialProvider that the API constructs from its DB + Vault. Running
 * them in the same process is the simplest Phase-0 deployment. In production
 * they can be split: the broker calls the API over HTTP/gRPC instead.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, type ApiConfig } from './config.js';
import { buildKeyring } from './keyring.js';
import { buildApp, type ApiServices, type SessionView } from './app.js';
import type { SessionRecord } from './ports.js';

import { getPrisma, type PrismaClient } from './db/client.js';
import {
  PrismaSessionRepo,
  PrismaTemplateRepo,
  PrismaInstanceRepo,
  PrismaEventRecorder,
  PrismaAuditRecorder,
  PrismaQuotaStore,
  PrismaUsageStore,
  PrismaStripeEventStore,
  PrismaSessionConnectStore,
  PrismaReaperDb,
  PrismaMembershipRepo,
  PrismaIdentityRepo,
  PrismaGuestBindingStore,
} from './db/prisma-repos.js';

import { FakeCloudProvider, AwsCloudProvider, type CloudProvider } from './cloud/provider.js';
import { NoPreBootInjector, OfflineImageInjector, deriveImageWrapKey, type PreBootInjector } from './cloud/disk-injector.js';
import { CloudInitInjector } from './cloud/cloud-init-injector.js';
import { FakeVaultClient, HttpVaultClient, type VaultClient } from './vault/vault-client.js';
import { InMemoryWrapTokenCache, type WrapTokenCache } from './vault/wrap-token-cache.js';
import { VaultCredentialIssuer } from './credentials/credential-issuer.js';
import { ConfiguredLaunchPlanner } from './pool/launch-planner.js';
import { PoolManager, type PoolManagerDb } from './pool/pool-manager.js';
import { Reaper } from './pool/reaper.js';
import { ReadinessReconciler } from './pool/readiness.js';
import { DevHeaderAuthenticator, FailClosedAuthenticator, type Authenticator, type Principal, type RoleResolver } from './auth/authenticator.js';
import { JoseAccessTokenVerifier } from './auth/jwks.js';
import { OidcAuthenticator } from './auth/oidc.js';

import { createSession, type CreateSessionInput, type CreateSessionResult } from './sessions/create-session.js';
import { endSession, type EndReason } from './sessions/end-session.js';
import { mintConnectToken } from '@disfap/broker/src/session-token.js';import { handleStripeWebhook } from './billing/webhook.js';
import { FakeStripeClient, RealStripeClient, type StripeClient } from './billing/stripe-client.js';

import { PrismaSessionResolver } from './integration/prisma-session-resolver.js';
import { VaultCredentialProvider } from './integration/vault-credential-provider.js';

import { createBroker, type ServerDeps as BrokerServerDeps } from '@disfap/broker/src/server.js';
import type { BrokerConfig } from '@disfap/broker/src/config.js';

import { createCredentialHsm } from './crypto/credential-key-store.js';
import type { HsmService } from './crypto/hsm-rsa.js';
import { PairKeyService, devFallbackMasterSeed } from './crypto/pair-keys.js';
import { InMemoryMarketplaceStore, type MarketplaceStore, type SoftwareLicense } from './marketplace/license-store.js';
import { PrismaMarketplaceStore } from './marketplace/prisma-license-store.js';
import { TwoThreadOrchestrator } from './orchestrator/two-thread-orchestrator.js';
import { RentalReaper } from './marketplace/rental-reaper.js';
import { GuestProvisioningService, type GuestProvisioningMode } from './guest/guest-provisioning.js';
import { AwsInstanceIdentityVerifier } from './guest/instance-identity.js';
import { StaticAwsCertProvider } from './guest/aws-cert-provider.js';
import { BindingResolver } from './guest/binding-resolver.js';
import { VaultGuestCredentialSource } from './guest/vault-credential-source.js';

export interface BuiltServer {
  services: ApiServices;
  reaper: Reaper;
  /** Layer 1/3 rental recovery loop (expired leases + abandoned claims). */
  rentalReaper: RentalReaper;
  /** Turns "VM launched" into "VM genuinely ready" (truthful readiness). */
  readiness: ReadinessReconciler;
  brokerBindings: { resolver: PrismaSessionResolver; credentialProvider: VaultCredentialProvider };
  wrapCache: WrapTokenCache;
  /** Dev seed catalog — written to the DB (if reachable) once at startup. */
  devSeeds?: SoftwareLicense[];
}

/** Construct everything from config + a Prisma client. */
export function buildServer(cfg: ApiConfig, prisma: PrismaClient): BuiltServer {
  const keyring = buildKeyring(cfg);
  const wrapCache: WrapTokenCache = new InMemoryWrapTokenCache();

  const cloud: CloudProvider = cfg.cloud === 'aws' && cfg.aws
    ? new AwsCloudProvider({
        region: cfg.aws.region,
        launchTemplateId: cfg.aws.launchTemplateId,
        ...(cfg.aws.launchTemplateVersion ? { launchTemplateVersion: cfg.aws.launchTemplateVersion } : {}),
      })
    : new FakeCloudProvider();

  const vault: VaultClient = cfg.vault
    ? new HttpVaultClient({ addr: cfg.vault.addr, token: cfg.vault.token, mount: cfg.vault.mount })
    : new FakeVaultClient();

  const sessions = new PrismaSessionRepo(prisma);
  const templates = new PrismaTemplateRepo(prisma);
  const instances = new PrismaInstanceRepo(prisma);
  const events = new PrismaEventRecorder(prisma);
  const audit = new PrismaAuditRecorder(prisma);
  const quota = new PrismaQuotaStore(prisma);
  const usage = new PrismaUsageStore(prisma);
  const stripeEvents = new PrismaStripeEventStore(prisma);
  const connectStore = new PrismaSessionConnectStore(prisma);

  const credentialIssuer = new VaultCredentialIssuer(vault);
  // Pair-key master (spec TA-4): per owner-rentee credential keys derive from
  // this seed via HKDF. Production sets DFAP_PAIR_MASTER_KEY (HSM/KMS-
  // managed); dev derives a deterministic seed from the signing kid so the
  // derived keys survive a dev restart. NEVER rely on the dev seed in
  // production — it is not a real secret.
  const pairMaster = buildPairMasterSeed(cfg);
  const pairKeys = new PairKeyService(pairMaster);
  const launchImageId = 'ami-phase0-placeholder';
  // Pre-boot injection realization. The sealed-blob injector needs a guest-side
  // decryption key; baking it into a reusable AMI is a shared secret across
  // every instance of that image (forbidden), so it is a DEV/TEST-ONLY seam. In
  // production we never place login material in userData: credentials are
  // delivered via the verified-instance-identity pull path (guestProvisioning),
  // which the config refuses to enable in production until real AWS
  // instance-identity verification is validated (audit C3 / M8).
  // Pre-boot injection realization.
  //  - production: NONE. The guest pulls its credential via the verified
  //    instance-identity path (audit C3 / M8); login material never rides in
  //    userData, and the config refuses to enable that path in production
  //    until real AWS instance-identity verification is validated.
  //  - real-AWS evaluation (`CLOUD_PROVIDER=aws`): the CloudInitInjector renders
  //    a cloud-config that creates the licensed demo account and brings up XFCE
  //    over xrdp on a STOCK AMI — there is no golden image in the eval topology.
  //  - otherwise (fake cloud / tests / offline dev): the sealed-blob injector.
  const injector: PreBootInjector =
    cfg.env === 'production'
      ? new NoPreBootInjector()
      : cfg.cloud === 'aws'
        ? new CloudInitInjector()
        : new OfflineImageInjector(deriveImageWrapKey(pairMaster));
  const planner = new ConfiguredLaunchPlanner(templates, {
    region: cfg.aws?.region ?? 'us-east-1',
    imageId: launchImageId,
    instanceType: 't4g.small',
    gpuInstanceType: 'g5.xlarge',
    hourlyCostUsd: 0.0168,
    gpuHourlyCostUsd: 1.006,
    expiryBufferS: 300,
  });

  // Guest credential provisioning (audit C3 / M8). Composed only when the mode
  // is explicitly enabled with cert material; production cannot select it (the
  // config refuses). The service verifies the AWS-signed instance identity,
  // enforces the server-side instance→session binding, and delivers the session
  // credential once — read from the SAME Vault path the broker uses.
  const guestProvisioning: GuestProvisioningService | undefined =
    (cfg.guestProvisioning as GuestProvisioningMode) === 'instance-identity'
      ? new GuestProvisioningService({
          mode: cfg.guestProvisioning,
          verifier: new AwsInstanceIdentityVerifier(new StaticAwsCertProvider(cfg.guestIdentityCerts ?? {})),
          bindings: new BindingResolver(new PrismaGuestBindingStore(prisma), { expectedImageId: launchImageId }),
          credentials: new VaultGuestCredentialSource(vault, (sid) => credentialIssuer.pathFor(sid)),
          ttlSeconds: cfg.guestProvisioningTtlS,
          maxDeliveries: cfg.guestProvisioningMaxDeliveries,
        })
      : undefined;
  // PrismaClient satisfies PoolManagerDb structurally; the cast pins the narrow
  // slice the manager needs (raw claim + poolInstance.create) without dragging
  // the full generated client types into the manager.
  const pool = new PoolManager({ db: prisma as unknown as PoolManagerDb, cloud, planner, injector });
  const reaper = new Reaper({ cloud, db: new PrismaReaperDb(prisma) });

  const stripe: StripeClient = cfg.stripe
    ? new RealStripeClient({ apiKey: cfg.stripe.apiKey, webhookSecret: cfg.stripe.webhookSecret })
    : new FakeStripeClient('whsec_dev');

  const hsm = createCredentialHsm(cfg.credentialKey, {
    production: cfg.env === 'production',
    devDefaultFile: resolve(process.cwd(), '.dfap', 'credential-key.pem'),
  });
  const seedLicenses: SoftwareLicense[] = [
    {
      id: 'lic_matlab_2024',
      softwareName: 'MATLAB & Simulink R2024b',
      version: 'R2024b',
      category: 'engineering',
      description: 'Matrix laboratory and numerical computation environment with full Simulink toolboxes.',
      os: 'windows',
      hourlyRateUsd: 4.5,
      ownerId: 'owner_edu_verified',
      ownerName: 'Academic License Pool',
      status: 'available',
      currentRenteeId: null,
      encryptedCredentials: hsm.encrypt(JSON.stringify({ username: 'matlab_user', password: 'DisFAP_Session_Password_2026!' })),
      templateId: 'tmpl_win_rdp',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'lic_autocad_2025',
      softwareName: 'Autodesk AutoCAD 2025',
      version: '2025.1',
      category: 'design',
      description: 'Industry-standard 2D and 3D CAD design platform with specialized architectural toolsets.',
      os: 'windows',
      hourlyRateUsd: 6.0,
      ownerId: 'owner_studio_cad',
      ownerName: 'ArchStudio Pro',
      status: 'available',
      currentRenteeId: null,
      encryptedCredentials: hsm.encrypt(JSON.stringify({ username: 'autocad_user', password: 'DisFAP_Cad_Secure_Key!' })),
      templateId: 'tmpl_win_rdp',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'lic_premiere_2024',
      softwareName: 'Adobe Premiere Pro 2024',
      version: '24.6',
      category: 'design',
      description: 'Professional video editing and color grading suite with hardware GPU acceleration.',
      os: 'windows',
      hourlyRateUsd: 5.5,
      ownerId: 'owner_creative_fx',
      ownerName: 'VFX Production Hub',
      status: 'available',
      currentRenteeId: null,
      encryptedCredentials: hsm.encrypt(JSON.stringify({ username: 'premiere_editor', password: 'DisFAP_Creative_Pass!' })),
      templateId: 'tmpl_win_rdp',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'lic_jetbrains_all',
      softwareName: 'JetBrains All Products Pack',
      version: '2024.3',
      category: 'development',
      description: 'Complete developer IDE suite including IntelliJ IDEA Ultimate, PyCharm Pro, and CLion.',
      os: 'linux',
      hourlyRateUsd: 3.5,
      ownerId: 'owner_dev_collective',
      ownerName: 'OpenDev Collective',
      status: 'available',
      currentRenteeId: null,
      encryptedCredentials: hsm.encrypt(JSON.stringify({ username: 'developer', password: 'DisFAP_Linux_Dev_Key!' })),
      templateId: 'tmpl_linux_dev',
      createdAt: new Date().toISOString(),
    },
  ];
  // Marketplace persistence. The in-memory catalog is a DEVELOPMENT fallback
  // only (cfg.devFallback, default false): it is attached to the Prisma store
  // solely when the flag is on, so a missing migration or unreachable DB
  // propagates as a real error in every other environment (audit finding H6).
  const marketplace: MarketplaceStore = new PrismaMarketplaceStore(
    prisma,
    cfg.devFallback ? new InMemoryMarketplaceStore(seedLicenses) : undefined,
  );

  // Normal-path teardown, shared by the HTTP end-session route and the
  // orchestrator's post-creation compensation (a rental that fails to persist
  // after the session already exists).
  const endSessionDeps = {
    sessions,
    instances,
    cloud,
    credentialIssuer,
    wrapCache,
    usage,
    events,
    audit,
    marketplace,
    ...(guestProvisioning ? { guestProvisioning } : {}),
  };
  const runEndSession = (sid: string, reason: EndReason, actor: string | null) =>
    endSession(sid, reason, actor, endSessionDeps);

  // Rental reaper: closes expired leases whose driven session is terminal/gone
  // and releases abandoned claims — but ONLY when no non-terminal session is
  // durably linked to the license, so an active session can never lose its
  // reservation (audit M2 follow-up).
  const rentalReaper = new RentalReaper({
    store: marketplace,
    sessions: {
      stateOf: async (sessionId) => (await sessions.findById(sessionId))?.state ?? null,
      hasActiveSessionForLicense: (licenseId) => sessions.hasActiveForLicense(licenseId),
    },
  });

  // Readiness reconciler (truthful readiness). A launched VM is NOT ready: on
  // the real-AWS path the session stays `allocating` until AWS reports the
  // instance `running` AND the gateway port (RDP 3389) accepts a connection;
  // only then does it become `ready`. A session that misses the budget is
  // FAILED (VM torn down, rental released) — never left hanging, never a
  // fabricated `ready`. On the fake cloud no session is ever `allocating`
  // (createSession marks it ready immediately), so this loop is a no-op there.
  const readyTimeoutMs = (Number(process.env['DFAP_READY_TIMEOUT_S'] ?? '600') || 600) * 1000;
  const readyProbePort = Number(process.env['DFAP_READY_PROBE_PORT'] ?? '3389') || 3389;
  const readiness = new ReadinessReconciler({
    sessions,
    instances,
    cloud,
    failSession: (sid) => runEndSession(sid, 'error', null),
    probePort: readyProbePort,
    readyTimeoutMs,
  });

  const createSessionImpl = (principal: Principal, input: CreateSessionInput): Promise<CreateSessionResult> =>
    createSession(principal, input, {
      sessions,
      templates,
      quota,
      pool,
      credentialIssuer,
      wrapCache,
      events,
      audit,
      keyring,
      config: {
        brokerUrl: cfg.brokerUrl,
        connectTokenTtlS: cfg.connectTokenTtlS,
        credentialTtlS: cfg.credentialTtlS,
      },
      // Marketplace grant validation (audit C2) + post-launch VM cleanup (H2).
      templateGrants: marketplace,
      cloud,
      instances,
      // On the real-AWS path the VM needs minutes to boot + install its desktop,
      // so we do NOT mark the session ready here: the readiness reconciler flips
      // it to `ready` only once AWS says `running` and the RDP port is open.
      deferReadiness: cfg.cloud === 'aws',
    });

  // The fabricated-session path is a DEVELOPMENT convenience only. With the
  // flag off, a genuine createSession failure propagates untouched so the HTTP
  // layer reports a real error instead of a fabricated 201 (audit finding C1).
  const safeCreateSession = async (
    principal: Principal,
    input: CreateSessionInput,
  ): Promise<CreateSessionResult> => {
    if (!cfg.devFallback) return createSessionImpl(principal, input);
    try {
      return await createSessionImpl(principal, input);
    } catch {
      const sid = `ses_dev_${Date.now().toString(16)}`;
      return {
        sessionId: sid,
        token: `DFAP1.dev_${sid}`,
        brokerUrl: cfg.brokerUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    }
  };

  const orchestrator = new TwoThreadOrchestrator({
    hsm,
    marketplace,
    createSession: safeCreateSession,
    // Compensation seam: tears down a session+VM when the rental row cannot be
    // persisted. The license claim is released only once this reports terminal.
    terminateSession: (sid) => runEndSession(sid, 'error', null),
    events,
    meter: { reportMeterEvent: (input) => stripe.reportMeterEvent(input) },
    pairKeys,
  });

  // Inbound authentication. Roles are ALWAYS resolved server-side from
  // `org_members` — a client never asserts privilege (audit C4). `authMode`
  // defaults to 'deny': every request is rejected until a provider is
  // configured. `dev-header` is local-dev only (config refuses it in prod);
  // `oidc` verifies JWT access tokens and maps (issuer, subject) → an internal
  // user through `external_identities`.
  const memberships = new PrismaMembershipRepo(prisma);
  const identities = new PrismaIdentityRepo(prisma);
  const resolveRole: RoleResolver = async (orgId, userId) => {
    if (cfg.devFallback) {
      try {
        const role = await memberships.roleOf(orgId, userId);
        if (role) return role;
      } catch {
        // Local dev without a reachable DB: fall through to least privilege.
      }
      return 'member';
    }
    return memberships.roleOf(orgId, userId);
  };
  const authenticator: Authenticator = ((): Authenticator => {
    switch (cfg.authMode) {
      case 'dev-header':
        return new DevHeaderAuthenticator(resolveRole);
      case 'oidc':
        // parseOidc guarantees cfg.oidc is present when this mode is selected;
        // if it were somehow absent, fail closed rather than trust anything.
        return cfg.oidc
          ? new OidcAuthenticator({
              verifier: new JoseAccessTokenVerifier(cfg.oidc),
              identities,
              memberships,
              ...(cfg.oidc.orgClaim ? { orgClaim: cfg.oidc.orgClaim } : {}),
            })
          : new FailClosedAuthenticator();
      default:
        return new FailClosedAuthenticator();
    }
  })();

  // Fresh DFAP1 connect handle for a connectable session. Minted on READ (the
  // browser polls getSession), never persisted, and carrying session id +
  // identity ONLY (ADR-002). Without this the client polls forever and never
  // reaches the tunnel — the missing link that blocked step 6 of the demo.
  const CONNECTABLE_STATES = new Set<string>(['ready', 'connected', 'idle']);
  const attachConnectHandle = (row: SessionRecord): SessionView => {
    if (!CONNECTABLE_STATES.has(row.state)) return row;
    const nowS = Math.floor(Date.now() / 1000);
    const token = mintConnectToken(
      { sid: row.id, sub: row.userId, org: row.orgId, ttlSeconds: cfg.connectTokenTtlS, now: nowS },
      keyring,
    );
    return {
      ...row,
      connect: {
        token,
        brokerUrl: cfg.brokerUrl,
        expiresAt: new Date((nowS + cfg.connectTokenTtlS) * 1000).toISOString(),
      },
    };
  };

  const services: ApiServices = {
    authenticator,
    listTemplates: async (principal) => {
      try {
        const active = templates.listActive ? await templates.listActive(principal.orgId) : [];
        if (active.length > 0) {
          return active.map((t) => ({
            id: t.id,
            name: t.name ?? (t.os === 'windows' ? 'Windows Desktop' : 'Linux Workspace'),
            os: t.os,
            recording: t.recordingEnabled,
          }));
        }
      } catch {
        // Fall back gracefully in offline dev
      }
      return [];
    },
    createSession: safeCreateSession,
    endSession: async (sid, reason, actor) => {
      // With the flag off, teardown failures are reported as failures — never
      // a fabricated `ended` that would hide a still-running VM (finding C1).
      if (!cfg.devFallback) return runEndSession(sid, reason, actor);
      try {
        return await runEndSession(sid, reason, actor);
      } catch {
        return {
          sessionId: sid,
          state: 'ended',
          endReason: reason,
          alreadyTerminal: false,
          billableSeconds: 0,
        };
      }
    },
    getSession: async (sid) => {
      // A nonexistent session resolves to null (⇒ 404); a genuine DB failure
      // propagates (⇒ 5xx) unless the explicit dev fallback is enabled.
      let row: SessionRecord | null;
      if (!cfg.devFallback) {
        row = await sessions.findById(sid);
      } else {
        row = await sessions.findById(sid).catch(() => ({
          id: sid,
          orgId: 'org_dev',
          userId: 'usr_dev',
          templateId: 'tmpl_linux_dev',
          instanceId: 'inst_dev',
          licenseId: null,
          state: 'ready' as const,
          requestedAt: new Date(),
          readyAt: new Date(),
          firstPixelAt: new Date(),
          connectedAt: new Date(),
          disconnectedAt: null,
          endedAt: null,
          endReason: null,
          billableSeconds: 0,
          vaultCredPath: null,
          clientIp: null,
          clientUa: null,
        }));
      }
      if (!row) return null;
      return attachConnectHandle(row);
    },
    handleWebhook: (rawBody, signature) => handleStripeWebhook(rawBody, signature, { stripe, events: stripeEvents }),
    marketplace,
    orchestrator,
    hsm,
    ...(guestProvisioning ? { guestProvisioning } : {}),
  };

  const brokerBindings = {
    resolver: new PrismaSessionResolver({ store: connectStore, wrapCache }),
    credentialProvider: new VaultCredentialProvider(vault),
  };

  return { services, reaper, rentalReaper, readiness, brokerBindings, wrapCache, devSeeds: seedLicenses };
}

/**
 * Pair-key master seed. `cfg.pairMasterKey` (base64, ≥32 bytes) is the
 * production path — `loadConfig` requires it in production. Outside production
 * a deterministic, NON-SECRET dev seed is derived from the signing kid so
 * derived pair keys survive a dev restart. A hand-built production config
 * without a seed is refused here too (fail closed).
 */
function buildPairMasterSeed(cfg: ApiConfig): Buffer {
  if (cfg.pairMasterKey) {
    const seed = Buffer.from(cfg.pairMasterKey, 'base64');
    if (seed.length < 32) {
      throw new Error('DFAP_PAIR_MASTER_KEY must decode to at least 32 bytes');
    }
    return seed;
  }
  if (cfg.env === 'production') {
    throw new Error('production requires DFAP_PAIR_MASTER_KEY (refusing the non-secret dev seed)');
  }
  return devFallbackMasterSeed(`pair-dev|${cfg.signingKid}`);
}

/**
 * One-time dev seed of the marketplace catalog. Skipped when the store
 * already has licenses (so restarts don't duplicate); harmless no-op on the
 * in-memory fallback, which is constructed with its seeds inline.
 */
export async function seedMarketplace(store: MarketplaceStore, seeds: SoftwareLicense[]): Promise<void> {
  const existing = await store.listAvailable();
  if (existing.length > 0) return;
  for (const lic of seeds) {
    await store.create(lic.ownerId, {
      softwareName: lic.softwareName,
      version: lic.version,
      category: lic.category,
      description: lic.description,
      os: lic.os,
      hourlyRateUsd: lic.hourlyRateUsd,
      ownerName: lic.ownerName,
      templateId: lic.templateId,
      encryptedCredentials: lic.encryptedCredentials,
    });
  }
}

/** Build the BrokerConfig from the same environment the API reads. */
function buildBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const brokerPort = Number(env['BROKER_PORT'] ?? '8080');
  return {
    port: Number.isFinite(brokerPort) ? brokerPort : 8080,
    path: env['BROKER_WS_PATH'] ?? '/tunnel',
    guacd: {
      host: env['GUACD_HOST'] ?? '127.0.0.1',
      port: Number(env['GUACD_PORT'] ?? '4822'),
      tls: env['GUACD_TLS'] === 'true',
    },
    // Shared keyring — same env vars parsed by both api and broker configs.
    signingKeys: (() => {
      const raw = env['DFAP_SIGNING_KEYS'] ?? '';
      const keys: Record<string, string> = {};
      for (const pair of raw.split(',')) {
        const [kid, b64] = pair.split(':');
        if (kid && b64) keys[kid.trim()] = b64.trim();
      }
      return keys;
    })(),
    signingKid: env['DFAP_SIGNING_KID'] ?? '',
    ...(env['REDIS_URL'] ? { redisUrl: env['REDIS_URL'] } : {}),
    maxClientViolations: Number(env['MAX_CLIENT_VIOLATIONS'] ?? '5'),
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const prisma = getPrisma(cfg.databaseUrl);
  const built = buildServer(cfg, prisma);
  const { services, reaper, rentalReaper, readiness, brokerBindings } = built;

  const app = buildApp(services, { logger: true, corsAllowedOrigins: cfg.corsAllowedOrigins });

  // ── Start the broker in-process ──────────────────────────────────────────
  // The broker requires a SessionResolver + CredentialProvider. In Phase-0
  // these are constructed here from the same Prisma DB and Vault client the
  // API uses. createBroker() returns a { start, stop } handle.
  const brokerCfg = buildBrokerConfig();
  const brokerDeps: BrokerServerDeps = {
    resolver: brokerBindings.resolver,
    credentials: brokerBindings.credentialProvider,
    onSecurityEvent: (e: unknown) => app.log.warn({ event: e }, 'broker security event'),
  };
  const broker = createBroker(brokerCfg, brokerDeps);
  const brokerPort = await broker.start();
  app.log.info({ port: brokerPort }, 'DisFAP broker listening');

  // Phase-0 reaper loop: reconcile the fleet and the rental ledger every 60s
  // (architecture.md layer 4 + marketplace recovery).
  const reaperTimer = setInterval(() => {
    reaper.reconcile().catch((err) => app.log.error({ err }, 'reaper reconcile failed'));
    rentalReaper.reconcile().catch((err) => app.log.error({ err }, 'rental reaper reconcile failed'));
  }, 60_000);
  reaperTimer.unref();

  // Readiness loop: every few seconds, promote `allocating` sessions whose VM
  // AWS now reports `running` and whose RDP port accepts a connection. This is
  // what makes the on-screen "provisioning" wait truthful — the client only
  // gets a connect handle once the guest is genuinely reachable.
  const readinessTimer = setInterval(() => {
    readiness.reconcile().catch((err) => app.log.error({ err }, 'readiness reconcile failed'));
  }, 5_000);
  readinessTimer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(reaperTimer);
    clearInterval(readinessTimer);
    await broker.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info({ port: cfg.port, env: cfg.env }, 'DisFAP control plane listening');

  // Best-effort dev seed of the software marketplace into the DB (no-ops when
  // already seeded or when the DB is unreachable and the in-memory fallback
  // is active).
  if (services.marketplace && built.devSeeds) {
    seedMarketplace(services.marketplace, built.devSeeds).catch((err) =>
      app.log.warn({ err }, 'marketplace seed skipped'),
    );
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || process.argv[1].endsWith('server.js'))) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('fatal: control plane failed to start', err);
    process.exit(1);
  });
}
