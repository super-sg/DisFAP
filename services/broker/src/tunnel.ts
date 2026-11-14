/**
 * The tunnel — where a browser WebSocket becomes a filtered pixel stream.
 *
 * Flow, per connection:
 *   1. Wait for the first client message: the DFAP1 connect token.
 *   2. Verify it (algorithm pinned, jti burned; replay ⇒ terminate the named
 *      session and refuse).
 *   3. Resolve sid → target + Vault wrap-token (authoritative, server-side).
 *   4. Fetch the credential from Vault, read-once.
 *   5. Open the protocol connection (guacd), injecting credential + lockdown
 *      params server-side. The credential never touches the client.
 *   6. Pipe both directions through the InstructionFilter:
 *        client → filter → guacd     (strict allowlist)
 *        guacd  → filter → client     (deny file/clipboard/pipe streams)
 *      Filter side-effects:
 *        - replies      → client (tunnel ping answers)
 *        - injectUpstream → guacd (denied-stream refusal acks)
 *        - violations   → security-event log; repeated c2s violations kill it.
 *   7. Any parse error, either direction, is a fatal protocol violation:
 *      terminate immediately. We never resynchronize a corrupt stream.
 *
 * The tunnel is transport- and protocol-agnostic: it speaks to a ClientSocket
 * and a ProtocolAdapter, both injectable, so it is fully unit-testable with no
 * network, no guacd, and no browser.
 */

import { GuacParseError } from './guac/parser.js';
import { InstructionFilter, type Violation } from './instruction-filter.js';
import type { ProtocolAdapter, ProtocolConnection } from './protocol/adapter.js';
import type { CredentialProvider } from './vault/credential-provider.js';
import type { SessionResolver } from './session-resolver.js';
import type { NonceStore } from './nonce-store.js';
import { verifyConnectToken, type Keyring } from './session-token.js';
import { scrubCredential } from './secrets.js';

/** Minimal WebSocket surface the tunnel needs — real ws or a test double. */
export interface ClientSocket {
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface SecurityEvent {
  sid?: string;
  kind: 'violation' | 'replay' | 'parse_error' | 'auth_failure' | 'server_failure' | 'connected' | 'closed';
  detail: string;
  violation?: Violation;
}

export interface TunnelDeps {
  adapter: ProtocolAdapter;
  keyring: Keyring;
  nonces: NonceStore;
  resolver: SessionResolver;
  credentials: CredentialProvider;
  onSecurityEvent?: (e: SecurityEvent) => void;
  /**
   * How many client→guacd instruction violations to tolerate before killing
   * the session. Server-side violations don't count against the client. A
   * well-behaved client emits zero; a small nonzero bound absorbs benign race
   * conditions (e.g. an in-flight instruction after resize) without letting a
   * probing client hammer the filter.
   */
  maxClientViolations?: number;
}

/** WebSocket close codes we use (1000 = normal, 4xxx = app-defined). */
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 4003; // auth/authorization failure
const CLOSE_PROTOCOL = 4002; // protocol violation / parse error
const CLOSE_SERVER = 4000; // server-side failure

const DEFAULT_MAX_CLIENT_VIOLATIONS = 5;

/**
 * What the control plane should do with the session when this tunnel closes.
 *  - `recoverable` — an ordinary transport drop while streaming: begin the
 *    bounded reconnect grace window.
 *  - `fatal`       — a security/protocol event already reported through
 *    `terminate()`: never grant a grace period.
 *  - `none`        — the session was never streaming at teardown (token
 *    rejection, failed handshake, credential failure); it is still in whatever
 *    connectable state it was and the client may request a fresh handle.
 */
type CloseDisposition = 'recoverable' | 'fatal' | 'none';

export class Tunnel {
  private readonly filter = new InstructionFilter();
  private upstream: ProtocolConnection | null = null;
  private sid: string | null = null;
  private clientViolations = 0;
  private phase: 'await_token' | 'connecting' | 'streaming' | 'closed' = 'await_token';
  private readonly maxClientViolations: number;

  constructor(
    private readonly client: ClientSocket,
    private readonly deps: TunnelDeps,
  ) {
    this.maxClientViolations = deps.maxClientViolations ?? DEFAULT_MAX_CLIENT_VIOLATIONS;
    this.client.onMessage((data) => void this.onClientMessage(data));
    // A browser socket going away is ordinary: Wi-Fi, laptop sleep, refresh, a
    // closed tab. Give the renter the grace window instead of destroying the VM.
    // The guacd side is still closed: with no consumer there is no stream to
    // keep alive, and the VM reconnect will open a fresh one.
    this.client.onClose(() => this.teardown('client closed', CLOSE_NORMAL, true, 'recoverable'));
    this.client.onError((err) => this.teardown(`client error: ${err.message}`, CLOSE_SERVER, true, 'recoverable'));
  }

  private emit(e: SecurityEvent): void {
    this.deps.onSecurityEvent?.(e);
  }

  /**
   * Explicit predicate rather than an inline comparison: TypeScript narrows
   * `this.phase` to the value assigned before an `await`, so a direct check
   * after an async boundary is reported as impossible even though another
   * callback (a socket close) can have changed it.
   */
  private isClosed(): boolean {
    return this.phase === 'closed';
  }

  /** Emit an event scoped to the current session, omitting `sid` when unknown. */
  private sec(kind: SecurityEvent['kind'], detail: string, violation?: Violation): void {
    this.emit({
      ...(this.sid ? { sid: this.sid } : {}),
      kind,
      detail,
      ...(violation ? { violation } : {}),
    });
  }

  private async onClientMessage(data: string): Promise<void> {
    if (this.isClosed()) return;
    if (this.phase === 'await_token') {
      await this.handleToken(data);
      return;
    }
    if (this.phase === 'connecting') {
      // Client sent input before guacd is ready. Buffer-free policy: drop it.
      // guacd isn't listening yet and the client will re-sync after 'ready'.
      return;
    }
    this.pumpClientToServer(data);
  }

  private async handleToken(raw: string): Promise<void> {
    const token = raw.trim();
    let result: Awaited<ReturnType<typeof verifyConnectToken>>;
    try {
      result = await verifyConnectToken(token, this.deps.keyring, this.deps.nonces);
    } catch {
      // The nonce store (Redis in a durable deployment) is unavailable. Fail
      // closed: without a single-use check a leaked token would be replayable.
      // Never let this rejection escape as an unhandled promise rejection.
      this.emit({ kind: 'auth_failure', detail: 'nonce store unavailable' });
      this.teardown('auth failure: nonce store unavailable', CLOSE_POLICY, false);
      return;
    }
    if (!result.ok) {
      if (result.terminateSession) {
        // Replay of a validly-signed token: we can read the sid to kill it.
        const sid = safePeekSid(token);
        if (sid) {
          await this.deps.resolver.terminate(sid, 'connect-token replay');
          this.emit({ sid, kind: 'replay', detail: 'connect token replayed; session terminated' });
        }
      } else {
        this.emit({ kind: 'auth_failure', detail: result.reason });
      }
      this.teardown(`auth failure: ${result.reason}`, CLOSE_POLICY, false);
      return;
    }

    this.sid = result.payload.sid;
    this.phase = 'connecting';

    // The capability's jti is part of the credential-handle lookup: a token
    // minted earlier cannot consume the wrap staged for a newer attempt.
    const resolved = await this.deps.resolver.resolve(this.sid, result.payload.jti);
    if (!resolved) {
      this.emit({ sid: this.sid, kind: 'auth_failure', detail: 'session not found' });
      this.teardown('session not found', CLOSE_POLICY, false);
      return;
    }
    if (resolved.org !== result.payload.org || resolved.sub !== result.payload.sub) {
      // Token identity must match the session record. Mismatch = misuse.
      this.emit({ sid: this.sid, kind: 'auth_failure', detail: 'token/session identity mismatch' });
      this.teardown('identity mismatch', CLOSE_POLICY, false);
      return;
    }
    if (
      resolved.state !== 'ready' &&
      resolved.state !== 'connected' &&
      resolved.state !== 'idle' &&
      resolved.state !== 'disconnected'
    ) {
      this.emit({ sid: this.sid, kind: 'auth_failure', detail: `session not connectable (${resolved.state})` });
      this.teardown(`session not connectable`, CLOSE_POLICY, false);
      return;
    }

    if (this.isClosed()) return; // client left while we resolved

    let credential;
    try {
      credential = await this.deps.credentials.fetch(this.sid, resolved.credentialWrapToken);
    } catch (err) {
      this.emit({ sid: this.sid, kind: 'server_failure', detail: `credential fetch failed: ${(err as Error).message}` });
      this.teardown('credential unavailable', CLOSE_SERVER, false);
      return;
    }

    if (this.isClosed()) {
      scrubCredential(credential);
      return;
    }

    try {
      this.upstream = await this.deps.adapter.connect(resolved.target, credential);
    } catch (err) {
      this.teardown(`guacd connect failed: ${(err as Error).message}`, CLOSE_SERVER, false);
      return;
    } finally {
      // The adapter has injected the credential into the handshake. Overwrite
      // the fields in place so neither this scope nor the in-process provider's
      // copy keeps the plaintext reachable longer than the connect call.
      scrubCredential(credential);
    }

    if (this.isClosed()) {
      this.upstream.close('client left during handshake');
      return;
    }

    // Claim the session atomically. If the reconnect-grace reaper (or another
    // tunnel) won the race, this connection must not become a second owner of a
    // session that is being torn down.
    const claimed = await this.deps.resolver.markConnected(this.sid);
    if (!claimed) {
      this.emit({ sid: this.sid, kind: 'auth_failure', detail: 'session no longer connectable' });
      this.teardown('session no longer connectable', CLOSE_POLICY, true);
      return;
    }

    this.wireUpstream(this.upstream);
    this.phase = 'streaming';
    this.emit({ sid: this.sid, kind: 'connected', detail: `adapter=${this.deps.adapter.name}` });
  }

  private wireUpstream(upstream: ProtocolConnection): void {
    upstream.onData((chunk) => this.pumpServerToClient(chunk));
    // guacd dying is a recoverable transport loss: the VM and rental survive so
    // the client can reconnect within the grace window.
    upstream.onClose((reason) => this.teardown(`upstream closed: ${reason}`, CLOSE_NORMAL, true, 'recoverable'));
    upstream.onError((err) => this.teardown(`upstream error: ${err.message}`, CLOSE_SERVER, true, 'recoverable'));
  }

  private pumpClientToServer(data: string): void {
    let out;
    try {
      out = this.filter.clientToServer(data);
    } catch (err) {
      if (err instanceof GuacParseError) {
        this.sec('parse_error', `c2s: ${err.message}`);
        void this.failProtocol('client stream parse error');
        return;
      }
      throw err;
    }
    for (const v of out.violations) {
      this.clientViolations++;
      this.sec('violation', v.reason, v);
    }
    for (const reply of out.replies) this.client.send(reply);
    if (out.forward && this.upstream) this.upstream.send(out.forward);
    if (this.clientViolations > this.maxClientViolations) {
      void this.terminateForAbuse();
    }
  }

  private pumpServerToClient(data: string): void {
    let out;
    try {
      out = this.filter.serverToClient(data);
    } catch (err) {
      if (err instanceof GuacParseError) {
        this.sec('parse_error', `s2c: ${err.message}`);
        void this.failProtocol('server stream parse error');
        return;
      }
      throw err;
    }
    // Server-side violations (guacd trying to open a file/clipboard stream)
    // are logged but do not count against the client — they indicate a
    // misconfiguration or a compromised guest, not client misbehavior.
    for (const v of out.violations) {
      this.sec('violation', v.reason, v);
    }
    for (const ack of out.injectUpstream) this.upstream?.send(ack);
    if (out.forward) this.client.send(out.forward);
  }

  private async terminateForAbuse(): Promise<void> {
    if (this.sid) {
      await this.deps.resolver.terminate(this.sid, 'excessive protocol violations').catch(() => undefined);
      this.emit({ sid: this.sid, kind: 'violation', detail: 'client exceeded violation budget; session terminated' });
    }
    // Fatal: the session was already marked `terminating`; no grace window.
    this.teardown('excessive protocol violations', CLOSE_PROTOCOL, false, 'fatal');
  }

  /**
   * A malformed instruction is a protocol-policy violation, not a network drop.
   * Fail closed: mark the session terminating (the lifecycle reaper performs
   * the full VM/credential cleanup) and close without a reconnect window.
   */
  private async failProtocol(reason: string): Promise<void> {
    if (this.sid) {
      await this.deps.resolver.terminate(this.sid, reason).catch(() => undefined);
    }
    this.teardown(reason, CLOSE_PROTOCOL, true, 'fatal');
  }

  private teardown(
    reason: string,
    code: number,
    closeUpstream: boolean,
    disposition: CloseDisposition = 'none',
  ): void {
    if (this.isClosed()) return;
    const wasStreaming = this.phase === 'streaming';
    this.phase = 'closed';
    this.sec('closed', reason);
    if (closeUpstream) this.upstream?.close(reason);
    try {
      this.client.close(code, reason.slice(0, 120));
    } catch {
      /* client already gone */
    }
    // Notify the control plane exactly once, and only when a live streaming
    // session is involved. A failed handshake or token rejection leaves the
    // session in its existing connectable state for a fresh attempt.
    if (wasStreaming && this.sid && disposition === 'recoverable') {
      void this.deps.resolver
        .markDisconnected(this.sid, reason)
        .catch(() => undefined); // the durable reaper remains the backstop
    }
  }
}

/**
 * Read the sid from an *unverified* token without trusting it, solely to
 * identify which session to terminate on replay. The token's signature was
 * already validated by verifyConnectToken before this is reached; we're just
 * re-extracting the sid it authenticated.
 */
function safePeekSid(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8'));
    return typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    return null;
  }
}
