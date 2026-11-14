/**
 * Fresh connect handles (credential re-issuance).
 *
 * A DFAP1 capability is single-use: the broker burns its `jti`, and the Vault
 * response-wrapping token staged for that jti is consumed by the same connect.
 * That is the correct security property, but it means a capability cannot be
 * reused for a page refresh, a retry after a failed guacd handshake, or a
 * network flap.
 *
 * This module is the re-issuance path. Every authorized read of a connectable
 * session:
 *
 *   1. asks Vault to response-wrap a READ of the existing session secret
 *      (no plaintext enters this process, and no second copy is written),
 *   2. mints a fresh capability with a fresh `jti`,
 *   3. stages the new wrap token under exactly that `(sid, jti)`.
 *
 * Because Vault holds the secret, re-issuance still works after an API restart
 * that lost every in-memory handle. Because the wrap is bound to the jti, an
 * old capability can never redeem a newer wrap. The browser only ever receives
 * the opaque capability — never the wrap token, never the credential.
 */

import { randomBytes } from 'node:crypto';

import { mintConnectToken, type Keyring } from '@disfap/broker/src/session-token.js';

import type { SessionRecord } from '../ports.js';
import type { CredentialIssuer } from '../credentials/credential-issuer.js';
import type { WrapTokenCache } from '../vault/wrap-token-cache.js';
import type { SessionState } from '../state-machine.js';

/** Fresh, single-use connect handle minted on read while a session is connectable. */
export interface SessionConnectHandle {
  /** Opaque DFAP1 capability token. Never carries host/credential (ADR-002). */
  token: string;
  /** Broker WebSocket base URL the client appends its tunnel path to. */
  brokerUrl: string;
  /** ISO expiry of `token`. */
  expiresAt: string;
}

/** States in which a client may still (re)establish a tunnel. */
const CONNECTABLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'ready',
  'connected',
  'idle',
  'disconnected',
]);

export interface ConnectHandleDeps {
  credentialIssuer: Pick<CredentialIssuer, 'reissue'>;
  wrapCache: WrapTokenCache;
  keyring: Keyring;
  brokerUrl: string;
  connectTokenTtlS: number;
  credentialTtlS: number;
  now?: () => Date;
}

/**
 * True when the session's disconnect grace window is still open. A session in
 * `disconnected` without a deadline (or past it) is NOT reconnectable: the
 * reaper is authoritative from that point on.
 */
export function isWithinReconnectGrace(session: SessionRecord, now: Date): boolean {
  if (session.state !== 'disconnected') return true;
  return session.disconnectDeadlineAt !== null && session.disconnectDeadlineAt.getTime() > now.getTime();
}

/** True when a fresh capability may be minted for this session right now. */
export function mayIssueConnectHandle(session: SessionRecord, now: Date): boolean {
  if (!CONNECTABLE_STATES.has(session.state)) return false;
  if (!session.vaultCredPath) return false; // nothing staged to wrap
  return isWithinReconnectGrace(session, now);
}

/**
 * Mint a capability + a matching Vault wrap handle, or null when this session
 * is not currently eligible. Never throws for ineligibility; a Vault failure
 * propagates so the caller can log it and retry on the next poll.
 */
export async function issueConnectHandle(
  session: SessionRecord,
  deps: ConnectHandleDeps,
): Promise<SessionConnectHandle | null> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  if (!mayIssueConnectHandle(session, at)) return null;

  // The wrap only has to outlive its capability, not the whole credential TTL.
  const wrapTtlS = Math.min(deps.credentialTtlS, deps.connectTokenTtlS + 60);
  const jti = randomBytes(16).toString('hex');
  const issued = await deps.credentialIssuer.reissue(session.id, wrapTtlS);
  if (!issued) return null; // secret revoked/expired: fail closed, mint nothing

  const nowS = Math.floor(at.getTime() / 1000);
  const token = mintConnectToken(
    {
      sid: session.id,
      sub: session.userId,
      org: session.orgId,
      ttlSeconds: deps.connectTokenTtlS,
      now: nowS,
      jti,
    },
    deps.keyring,
  );
  deps.wrapCache.put(session.id, jti, issued.wrapToken, wrapTtlS);
  return {
    token,
    brokerUrl: deps.brokerUrl,
    expiresAt: new Date((nowS + deps.connectTokenTtlS) * 1000).toISOString(),
  };
}
