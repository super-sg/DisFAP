/**
 * Session presentation and per-session authorization, shared by the session and
 * marketplace route modules.
 *
 * Two distinct questions, deliberately kept apart:
 *
 *  - **read**  — may this caller be handed the session (and therefore a fresh
 *    single-use connect handle)? A handle authenticates *as the renter* at the
 *    broker, so reading a peer's session is account sharing by another name.
 *    Only the renter of record may read it.
 *  - **control** — may this caller end it? The renter, plus a tenant
 *    admin/owner for operational recovery of a stuck session.
 *
 * Both first require tenant membership; a cross-tenant caller learns nothing
 * beyond `403`.
 */

import type { Principal } from '../auth/authenticator.js';
import type { SessionRecord } from '../ports.js';
import type { SessionView } from './contracts.js';

/** HTTP status + body for a denied per-session action, or `null` when allowed. */
export type Denial = { status: 403; error: string } | null;

const FORBIDDEN: Denial = { status: 403, error: 'forbidden' };

/** Only the renter of record may read a session (and receive a connect handle). */
export function readDenial(principal: Principal, session: SessionRecord): Denial {
  if (session.orgId !== principal.orgId) return FORBIDDEN;
  if (session.userId !== principal.userId) return FORBIDDEN;
  return null;
}

/** The renter of record, or a tenant admin/owner, may end a session. */
export function controlDenial(principal: Principal, session: SessionRecord): Denial {
  if (session.orgId !== principal.orgId) return FORBIDDEN;
  if (session.userId === principal.userId) return null;
  if (principal.role === 'admin' || principal.role === 'owner') return null;
  return FORBIDDEN;
}

/** Client-safe view of a session — never the connect token or credential. */
export function publicSession(s: SessionView) {
  return {
    id: s.id,
    orgId: s.orgId,
    userId: s.userId,
    templateId: s.templateId,
    instanceId: s.instanceId,
    state: s.state,
    requestedAt: s.requestedAt,
    readyAt: s.readyAt,
    connectedAt: s.connectedAt,
    // Lets the client show "reconnect by …" honestly instead of guessing.
    disconnectDeadlineAt: s.disconnectDeadlineAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
    billableSeconds: s.billableSeconds,
    // Fresh single-use connect handle, present only while connectable. This is
    // the ONLY way the browser learns how to reach its session; it carries no
    // host, port, username or password (docs/security.md, Guarantee 2).
    ...(s.connect !== undefined ? { connect: s.connect } : {}),
  };
}
