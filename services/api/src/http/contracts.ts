/**
 * HTTP-layer contracts: the shape of the service bag the app factory receives
 * and the shapes it returns. These live beside the routes (not in `app.ts`) so
 * a route module can be read and changed without touching the Fastify wiring,
 * and so the dependency direction is one-way:
 *
 *   app.ts ──▶ http/routes/* ──▶ http/contracts.ts ──▶ domain services
 *
 * Nothing here imports `app.ts`.
 */

import type { Authenticator, Principal } from '../auth/authenticator.js';
import type { CreateSessionInput, CreateSessionResult } from '../sessions/create-session.js';
import type { EndReason, EndSessionResult } from '../sessions/end-session.js';
import type { SessionConnectHandle } from '../sessions/connect-handle.js';
import type { SessionRecord } from '../ports.js';
import type { WebhookResult } from '../billing/webhook.js';
import type { MarketplaceStore } from '../marketplace/license-store.js';
import type { TwoThreadOrchestrator } from '../orchestrator/two-thread-orchestrator.js';
import type { HsmService } from '../crypto/hsm-rsa.js';
import type { GuestProvisioningService } from '../guest/guest-provisioning.js';
import type { RateLimitRules } from './rate-limit.js';

export interface ApiTemplate {
  id: string;
  name: string;
  os: 'windows' | 'linux';
  recording: boolean;
}

/** Re-exported so HTTP consumers have one import surface (definition is domain-side). */
export type { SessionConnectHandle } from '../sessions/connect-handle.js';

/** A session row plus an optional freshly-minted connect handle. */
export type SessionView = SessionRecord & { connect?: SessionConnectHandle };

export interface ApiServices {
  authenticator: Authenticator;
  listTemplates?(principal: Principal): Promise<ApiTemplate[]>;
  createSession(principal: Principal, input: CreateSessionInput): Promise<CreateSessionResult>;
  endSession(sid: string, reason: EndReason, actor: string | null): Promise<EndSessionResult>;
  getSession(sid: string): Promise<SessionView | null>;
  /**
   * Mint a fresh capability AND a matching Vault wrap handle for an authorized
   * read. Authorization is the route's job (it must run before this call);
   * this returns null when the session is not currently connectable or its
   * credential is gone. Optional so route tests can supply a static view.
   */
  issueConnectHandle?(session: SessionRecord): Promise<SessionConnectHandle | null>;
  handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult>;
  marketplace?: MarketplaceStore;
  orchestrator?: TwoThreadOrchestrator;
  hsm?: HsmService;
  /**
   * Guest credential provisioning (audit C3 / M8). Absent ⇒ the endpoint fails
   * closed with 503. The service verifies instance identity itself; it does NOT
   * go through the user authenticator (a booting guest has no user).
   */
  guestProvisioning?: GuestProvisioningService;
}

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * Exact browser origins allowed to make credentialed CORS requests. Defaults
   * to none: an unapproved origin receives no `Access-Control-Allow-Origin` and
   * the browser blocks it. The API never reflects an arbitrary `Origin` and
   * never pairs `*` with credentials (audit finding C4).
   */
  corsAllowedOrigins?: string[];
  /** Max request body in bytes. Default 128 KiB — every accepted body is tiny. */
  bodyLimitBytes?: number;
  /**
   * Trust proxy hops for `X-Forwarded-For`. `true` trusts every hop (safe only
   * when the immediate proxy overwrites the header); a function receives
   * `(address, hop)` so a single trusted hop can be expressed as `hop === 0`
   * (Fastify's types do not accept a bare number). Set ONLY when the API is
   * unreachable except through a proxy; otherwise a client could forge its own
   * address (and its rate-limit bucket).
   */
  trustProxy?: boolean | ((address: string, hop: number) => boolean);
  /**
   * Override the built-in abuse limits, or `false` to disable them. Tests that
   * need to exercise a limiter inject a small rule set instead of switching the
   * control off.
   */
  rateLimits?: Partial<RateLimitRules> | false;
}

/** Used only when the deployment does not supply a template catalog. */
export const FALLBACK_TEMPLATES: readonly ApiTemplate[] = [
  { id: 'tmpl_linux_dev', name: 'Ubuntu 22.04 LTS (DevBox)', os: 'linux', recording: false },
  { id: 'tmpl_win_rdp', name: 'Windows Server 2022 (Standard)', os: 'windows', recording: true },
];

/** Longest rental the API will accept, in hours. Matches the UI's 1/2/4/8 choice. */
export const MAX_RENTAL_HOURS = 24;
