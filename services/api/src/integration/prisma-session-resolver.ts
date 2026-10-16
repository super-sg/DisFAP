/**
 * PrismaSessionResolver — the control-plane implementation of the broker's
 * `SessionResolver` interface. This closes the API<->broker loop: the broker
 * verifies a DFAP1 token, extracts the `sid`, and calls `resolve(sid)` here to
 * learn the concrete target VM and obtain the single-use Vault wrap token.
 *
 * The wrap token comes from the in-process `WrapTokenCache` (staged at
 * `POST /sessions`), never from Postgres — the DB stores only the Vault path.
 * A read-model port keeps this class free of the generated Prisma client so it
 * is testable and the Prisma query lives in one place (`db/prisma-repos.ts`).
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
}

export interface SessionConnectStore {
  loadForConnect(sid: string): Promise<SessionConnectRow | null>;
  markConnected(sid: string, at: Date): Promise<void>;
  markTerminating(sid: string, reason: string, at: Date): Promise<void>;
}

/** Default listen ports per protocol when the template doesn't override. */
const DEFAULT_PORT: Record<'rdp' | 'vnc', number> = { rdp: 3389, vnc: 5900 };

/** Map our richer session lifecycle onto the broker's connect-relevant view. */
function toBrokerState(state: SessionState): ResolvedSession['state'] {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'connected':
      return 'connected';
    case 'idle':
      return 'idle';
    default:
      return 'other';
  }
}

export interface PrismaSessionResolverDeps {
  store: SessionConnectStore;
  wrapCache: WrapTokenCache;
  now?: () => Date;
}

export class PrismaSessionResolver implements SessionResolver {
  private readonly store: SessionConnectStore;
  private readonly wrapCache: WrapTokenCache;
  private readonly now: () => Date;

  constructor(deps: PrismaSessionResolverDeps) {
    this.store = deps.store;
    this.wrapCache = deps.wrapCache;
    this.now = deps.now ?? (() => new Date());
  }

  async resolve(sid: string): Promise<ResolvedSession | null> {
    const row = await this.store.loadForConnect(sid);
    if (!row) return null;
    // The guacd broker only serves rdp/vnc; dcv rides a different adapter.
    if (row.protocol !== 'rdp' && row.protocol !== 'vnc') return null;
    if (!row.host) return null; // VM not far enough along to accept a connection

    const wrapToken = this.wrapCache.take(sid);
    if (!wrapToken) return null; // no live credential handle -> refuse

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

  async markConnected(sid: string): Promise<void> {
    await this.store.markConnected(sid, this.now());
  }

  async terminate(sid: string, reason: string): Promise<void> {
    // Called by the broker on replay detection / protocol violation. Drop the
    // wrap token immediately so nothing else can resolve this session.
    this.wrapCache.drop(sid);
    await this.store.markTerminating(sid, reason, this.now());
  }
}
