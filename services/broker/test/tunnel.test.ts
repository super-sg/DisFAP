import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { Tunnel, type ClientSocket, type SecurityEvent, type TunnelDeps } from '../src/tunnel.js';
import { InMemoryNonceStore } from '../src/nonce-store.js';
import { InMemorySessionResolver } from '../src/session-resolver.js';
import { StaticCredentialProvider } from '../src/vault/credential-provider.js';
import { mintConnectToken, type Keyring } from '../src/session-token.js';
import { formatInstruction } from '../src/guac/serialize.js';
import type {
  ProtocolAdapter,
  ProtocolConnection,
  SessionCredential,
  SessionTarget,
} from '../src/protocol/adapter.js';

const i = formatInstruction;

/** A client socket double capturing everything sent to the browser. */
class FakeClient implements ClientSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private msg?: (d: string) => void;
  private close_?: () => void;
  private err?: (e: Error) => void;

  onMessage(h: (d: string) => void) { this.msg = h; }
  onClose(h: () => void) { this.close_ = h; }
  onError(h: (e: Error) => void) { this.err = h; }
  send(d: string) { this.sent.push(d); }
  close(code: number, reason: string) { this.closed = { code, reason }; this.close_?.(); }

  // test drivers
  deliver(d: string) { this.msg?.(d); }
  fail(e: Error) { this.err?.(e); }
  get sentWire() { return this.sent.join(''); }
}

/** A protocol connection double capturing what the tunnel forwards to guacd. */
class FakeUpstream implements ProtocolConnection {
  toServer: string[] = [];
  closed = false;
  private data?: (c: string) => void;
  private close_?: (r: string) => void;

  onData(h: (c: string) => void) { this.data = h; }
  onClose(h: (r: string) => void) { this.close_ = h; }
  onError() {}
  send(w: string) { this.toServer.push(w); }
  close() { this.closed = true; this.close_?.('closed'); }

  emit(c: string) { this.data?.(c); }
  get toServerWire() { return this.toServer.join(''); }
}

class FakeAdapter implements ProtocolAdapter {
  readonly name = 'fake';
  lastTarget: SessionTarget | null = null;
  lastCredential: SessionCredential | null = null;
  upstream = new FakeUpstream();
  failConnect = false;

  async connect(target: SessionTarget, credential: SessionCredential): Promise<ProtocolConnection> {
    if (this.failConnect) throw new Error('guacd down');
    this.lastTarget = target;
    this.lastCredential = credential;
    return this.upstream;
  }
}

const target: SessionTarget = {
  sid: 'ses_1', protocol: 'rdp', host: '10.0.1.5', port: 3389, width: 1920, height: 1080, dpi: 96,
};

function ring(): Keyring {
  return { keys: new Map([['k1', randomBytes(32)]]), signingKid: 'k1' };
}

interface Harness {
  client: FakeClient;
  adapter: FakeAdapter;
  resolver: InMemorySessionResolver;
  creds: StaticCredentialProvider;
  keyring: Keyring;
  nonces: InMemoryNonceStore;
  events: SecurityEvent[];
  tunnel: Tunnel;
  validToken: () => string;
}

function harness(overrides: Partial<TunnelDeps> = {}): Harness {
  const client = new FakeClient();
  const adapter = new FakeAdapter();
  const resolver = new InMemorySessionResolver();
  const creds = new StaticCredentialProvider();
  const keyring = ring();
  const nonces = new InMemoryNonceStore();
  const events: SecurityEvent[] = [];

  resolver.put('ses_1', {
    target,
    credentialWrapToken: 'wrap-abc',
    state: 'ready',
    org: 'org_1',
    sub: 'usr_1',
  });
  creds.put('ses_1', 'wrap-abc', { username: 'session-user', password: 'S3cr3t' });

  const deps: TunnelDeps = {
    adapter, keyring, nonces, resolver, credentials: creds,
    onSecurityEvent: (e) => events.push(e),
    ...overrides,
  };
  const tunnel = new Tunnel(client, deps);
  return {
    client, adapter, resolver, creds, keyring, nonces, events, tunnel,
    validToken: () => mintConnectToken({ sid: 'ses_1', sub: 'usr_1', org: 'org_1' }, keyring),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Tunnel — auth and connect', () => {
  it('connects on a valid token and injects the credential server-side', async () => {
    const h = harness();
    h.client.deliver(h.validToken());
    await tick();
    expect(h.adapter.lastTarget?.sid).toBe('ses_1');
    expect(h.adapter.lastCredential).toEqual({ username: 'session-user', password: 'S3cr3t' });
    expect(h.events.some((e) => e.kind === 'connected')).toBe(true);
    // The credential must never have been sent toward the client.
    expect(h.client.sentWire).not.toContain('S3cr3t');
    expect(h.client.sentWire).not.toContain('session-user');
  });

  it('rejects and does not connect on a bad signature', async () => {
    const h = harness();
    const other = mintConnectToken({ sid: 'ses_1', sub: 'usr_1', org: 'org_1' }, ring());
    h.client.deliver(other);
    await tick();
    expect(h.adapter.lastTarget).toBeNull();
    expect(h.client.closed?.code).toBe(4003);
    expect(h.events.some((e) => e.kind === 'auth_failure')).toBe(true);
  });

  it('terminates the named session on connect-token replay', async () => {
    const h = harness();
    const token = h.validToken();
    h.client.deliver(token);
    await tick();
    // Second tunnel, same token → replay.
    const client2 = new FakeClient();
    const events2: SecurityEvent[] = [];
    new Tunnel(client2, {
      adapter: new FakeAdapter(), keyring: h.keyring, nonces: h.nonces,
      resolver: h.resolver, credentials: h.creds, onSecurityEvent: (e) => events2.push(e),
    });
    client2.deliver(token);
    await tick();
    expect(events2.some((e) => e.kind === 'replay')).toBe(true);
    expect(h.resolver.terminated.some((t) => t.sid === 'ses_1')).toBe(true);
    expect(client2.closed?.code).toBe(4003);
  });

  it('rejects when the token identity does not match the session record', async () => {
    const h = harness();
    const token = mintConnectToken({ sid: 'ses_1', sub: 'usr_INTRUDER', org: 'org_1' }, h.keyring);
    h.client.deliver(token);
    await tick();
    expect(h.adapter.lastTarget).toBeNull();
    expect(h.events.some((e) => e.detail.includes('identity mismatch'))).toBe(true);
  });

  it('rejects a connection to an unknown session', async () => {
    const h = harness();
    const token = mintConnectToken({ sid: 'ses_MISSING', sub: 'usr_1', org: 'org_1' }, h.keyring);
    h.client.deliver(token);
    await tick();
    expect(h.client.closed?.code).toBe(4003);
  });

  it('fails closed when the credential was already consumed', async () => {
    const h = harness();
    // Consume the credential out-of-band first.
    await h.creds.fetch('ses_1', 'wrap-abc');
    h.client.deliver(h.validToken());
    await tick();
    expect(h.adapter.lastTarget).toBeNull();
    expect(h.client.closed?.code).toBe(4000);
    expect(h.events.some((e) => e.kind === 'server_failure')).toBe(true);
  });

  it('closes cleanly when guacd connect fails', async () => {
    const h = harness();
    h.adapter.failConnect = true;
    h.client.deliver(h.validToken());
    await tick();
    expect(h.client.closed?.code).toBe(4000);
  });
});

describe('Tunnel — streaming and filtering', () => {
  async function connected(): Promise<Harness> {
    const h = harness();
    h.client.deliver(h.validToken());
    await tick();
    return h;
  }

  it('forwards allowed client input to guacd and drops the rest', async () => {
    const h = await connected();
    h.client.deliver(i('mouse', '10', '20', '1') + i('clipboard', '3', 'text/plain') + i('key', '65', '1'));
    expect(h.adapter.upstream.toServerWire).toBe(i('mouse', '10', '20', '1') + i('key', '65', '1'));
    expect(h.events.some((e) => e.kind === 'violation' && e.violation?.opcode === 'clipboard')).toBe(true);
  });

  it('streams pixels from guacd to the client while suppressing a clipboard exfil stream', async () => {
    const h = await connected();
    const secret = Buffer.from('DEAL-TERMS').toString('base64');
    h.adapter.upstream.emit(
      i('img', '1', '12', '0', 'image/png', '0', '0') +
        i('blob', '1', 'cGl4') +
        i('clipboard', '2', 'text/plain') +
        i('blob', '2', secret) +
        i('end', '2') +
        i('end', '1'),
    );
    expect(h.client.sentWire).toContain('cGl4'); // image pixels reach the client
    expect(h.client.sentWire).not.toContain(secret); // clipboard payload does not
    expect(h.adapter.upstream.toServerWire).toContain('ack'); // refusal ack sent to guacd
  });

  it('answers tunnel pings without forwarding them to guacd', async () => {
    const h = await connected();
    h.adapter.upstream.toServer.length = 0;
    h.client.deliver(i('', 'ping', '123'));
    expect(h.client.sent).toContain(i('', 'ping', '123'));
    expect(h.adapter.upstream.toServerWire).toBe('');
  });

  it('terminates the session after the client exceeds the violation budget', async () => {
    const h = harness({ maxClientViolations: 2 });
    h.client.deliver(h.validToken());
    await tick();
    for (let n = 0; n < 4; n++) h.client.deliver(i('file', String(n), 'text/plain', 'x'));
    await tick();
    expect(h.resolver.terminated.some((t) => t.reason.includes('violation'))).toBe(true);
    expect(h.client.closed?.code).toBe(4002);
  });

  it('terminates on a malformed client stream (fatal, no resync)', async () => {
    const h = await connected();
    h.client.deliver('bogus-not-guac|');
    await tick();
    expect(h.client.closed?.code).toBe(4002);
    expect(h.events.some((e) => e.kind === 'parse_error')).toBe(true);
    expect(h.adapter.upstream.closed).toBe(true);
  });

  it('closes the client when guacd closes', async () => {
    const h = await connected();
    h.adapter.upstream.close();
    await tick();
    expect(h.client.closed).not.toBeNull();
  });
});
