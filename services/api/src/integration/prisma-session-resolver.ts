/**
 * PrismaSessionResolver — the control-plane implementation of the broker's
 * `SessionResolver`. It closes the API<->broker loop: the broker verifies a
 * DFAP1 token, extracts `(sid, jti)`, and calls `resolve()` here to learn the
 * concrete target VM and obtain the single-use Vault wrap token staged for THAT
 * capability.
 *
 * The wrap token comes from the in-process `WrapTokenCache`, never from
 * Postgres — the DB stores only the Vault path. Keying the lookup on the jti is
 * what prevents an old capability from redeeming a newer one; the Prisma query
 * lives in `db/repos/session.ts`.
 *
 * Lifecycle notifications use conditional writes in the store:
 *  - `markConnected` returns false if the grace reaper claimed the session
 *    first, so the broker refuses rather than reviving a dying session;
 *  - `markDisconnected` persists the reconnect deadline (computed here from
 *    config) so the window survives an API restart;
 *  - `terminate` is the security-fatal path and grants no grace at all.
 */

import type { SessionResolver, ResolvedSession } from '@disfap/broker/src/session-resolver.js';
import type { SessionTarget } from '@disfap/broker/src/protocol/adapter.js';

import type { SessionState } from '../state-machine.js';
import type { WrapTokenCache } from '../vault/wrap-token-cache.js';

/** Denormalized row the resolver needs to build a `SessionTarget`. */
export interface SessionConnectRow {
  sid: string;
  state: SessionState;
  org: string;
  sub: string;
  protocol: 'rdp' | 'vnc' | 'dcv';
  /** Instance private IP; null until the VM has one. */
  host: string | null;
  width: number;
  height: number;
  dpi: number;
  recordingEnabled: boolean;
  /** Reconnect deadline while `state === 'disconnected'`. */
  disconnectDeadlineAt: Date | null;
}

export interface SessionConnectStore {
  loadForConnect(sid: string): Promise<SessionConnectRow | null>;
  /** Atomic `disconnected → connected` claim (also accepts ready/idle). */
  markConnected(sid: string, at: Date): Promise<boolean>;
  /** Persist the recoverable-drop window: state + deadline in one write. */
  markDisconnected(sid: string, at: Date, deadline: Date): Promise<boolean>;
  markTerminating(sid: string, reason: string, at: Date): Promise<void>;
}

/** Default listen ports per protocol when the template doesn't override. */
const DEFAULT_PORT: Record<'rdp' | 'vnc', number> = { rdp: 3389, vnc: 5900 };

/** Default grace window if the composition root does not supply one. */
const DEFAULT_GRACE_SECONDS = 30;

/** Map our richer session lifecycle onto the broker's connect-relevant view. */
function toBrokerState(state: SessionState): ResolvedSession['state'] {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'connected':
      return 'connected';
    case 'idle':
      return 'idle';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'other';
  }
}

export interface PrismaSessionResolverDeps {
  store: SessionConnectStore;
  wrapCache: WrapTokenCache;
  /** Bounded reconnect window, seconds. */
  graceSeconds?: number;
  now?: () => Date;
}

export class PrismaSessionResolver implements SessionResolver {
  private readonly store: SessionConnectStore;
  private readonly wrapCache: WrapTokenCache;
  private readonly graceSeconds: number;
  private readonly now: () => Date;

  constructor(deps: PrismaSessionResolverDeps) {
    this.store = deps.store;
    this.wrapCache = deps.wrapCache;
    this.graceSeconds = Math.max(1, deps.graceSeconds ?? DEFAULT_GRACE_SECONDS);
    this.now = deps.now ?? (() => new Date());
  }

  async resolve(sid: string, jti: string): Promise<ResolvedSession | null> {
    const row = await this.store.loadForConnect(sid);
    if (!row) return null;
    // The guacd broker only serves rdp/vnc; dcv rides a different adapter.
    if (row.protocol !== 'rdp' && row.protocol !== 'vnc') return null;
    if (!row.host) return null; // VM not far enough along to accept a connection

    const now = this.now();
    const reconnectOpen =
      row.state === 'disconnected' &&
      row.disconnectDeadlineAt !== null &&
      row.disconnectDeadlineAt.getTime() > now.getTime();
    const connectable =
      row.state === 'ready' || row.state === 'connected' || row.state === 'idle' || reconnectOpen;
    if (!connectable) return null; // grace expired (or never connectable)

    // Exactly this capability's handle. A miss (consumed, expired, or minted
    // for a different jti) is a refusal, never a fallback to the session id.
    const wrapToken = this.wrapCache.take(sid, jti);
    if (!wrapToken) return null;

    const target: SessionTarget = {
      sid: row.sid,
      protocol: row.protocol,
      host: row.host,
      port: DEFAULT_PORT[row.protocol],
      width: row.width,
      height: row.height,
      dpi: row.dpi,
      ...(row.recordingEnabled ? { recording: { path: `/recordings/${sid}`, name: sid } } : {}),
    };

    return {
      target,
      credentialWrapToken: wrapToken,
      state: toBrokerState(row.state),
      org: row.org,
      sub: row.sub,
    };
  }

  async markConnected(sid: string): Promise<boolean> {
    return this.store.markConnected(sid, this.now());
  }

  async markDisconnected(sid: string, _reason: string): Promise<void> {
    const at = this.now();
    const deadline = new Date(at.getTime() + this.graceSeconds * 1000);
    await this.store.markDisconnected(sid, at, deadline);
  }

  async terminate(sid: string, reason: string): Promise<void> {
    // Called by the broker on replay detection / protocol violation. Drop every
    // wrap handle immediately so nothing else can resolve this session, then
    // mark it terminating (no grace). The lifecycle reaper runs the full
    // teardown; this path never grants a reconnect window.
    this.wrapCache.drop(sid);
    await this.store.markTerminating(sid, reason, this.now());
  }
}
