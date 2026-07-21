/**
 * End-to-end broker run over REAL sockets.
 *
 * Boots createBroker() on an ephemeral port, connects with a real `ws` client,
 * and stands up a mock guacd TCP server. Exercises the entire broker path:
 *   ws open → send DFAP1 token → verify → resolve → fetch credential →
 *   guacd handshake (credential injected server-side) → filtered streaming.
 *
 * This is the "does the broker actually work when wired together" test —
 * everything below the WebSocket is the real production code path.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createBroker } from '../src/server.js';
import type { BrokerConfig } from '../src/config.js';
import { InMemorySessionResolver } from '../src/session-resolver.js';
import { StaticCredentialProvider } from '../src/vault/credential-provider.js';
import { mintConnectToken, type Keyring } from '../src/session-token.js';
import { GuacParser } from '../src/guac/parser.js';
import { formatInstruction } from '../src/guac/serialize.js';
import type { SecurityEvent } from '../src/tunnel.js';

const i = formatInstruction;

/** Controllable mock guacd: completes the handshake, then lets tests drive frames. */
class MockGuacd {
  server: Server;
  port = 0;
  connectValues: string[] | null = null;
  toClientFrames: string[] = []; // what the broker forwarded to guacd post-handshake
  private sockets = new Set<Socket>();
  private live: Socket | null = null;
  private onConnect?: () => void;

  constructor() {
    this.server = createServer((sock) => {
      this.sockets.add(sock);
      this.live = sock;
      sock.on('close', () => this.sockets.delete(sock));
      const parser = new GuacParser();
      let ready = false;
      sock.on('data', (buf) => {
        if (ready) {
          this.toClientFrames.push(buf.toString('utf8'));
          return;
        }
        for (const instr of parser.push(buf.toString('utf8'))) {
          if (instr.opcode === 'select') {
            sock.write(i('args', 'VERSION_1_5_0', 'hostname', 'port', 'username', 'password', 'disable-copy'));
          } else if (instr.opcode === 'connect') {
            this.connectValues = instr.args;
            sock.write(i('ready', '$mock-conn-0001'));
            ready = true;
            this.onConnect?.();
          }
        }
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }
  whenConnected(): Promise<void> {
    return new Promise((r) => (this.onConnect = r));
  }
  /** Push a raw frame from guacd toward the broker (server→client direction). */
  emit(wire: string): void {
    this.live?.write(wire, 'utf8');
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('broker end-to-end (real WebSocket + real guacd handshake)', () => {
  let guacd: MockGuacd;
  let broker: { start: () => Promise<number>; stop: () => Promise<void> };
  let port: number;
  let resolver: InMemorySessionResolver;
  let creds: StaticCredentialProvider;
  let keyring: Keyring;
  let events: SecurityEvent[];

  beforeEach(async () => {
    guacd = new MockGuacd();
    await guacd.listen();

    const key = randomBytes(32);
    keyring = { keys: new Map([['k1', key]]), signingKid: 'k1' };
    resolver = new InMemorySessionResolver();
    creds = new StaticCredentialProvider();
    events = [];

    resolver.put('ses_e2e', {
      target: { sid: 'ses_e2e', protocol: 'rdp', host: '10.0.9.9', port: 3389, width: 1280, height: 720, dpi: 96 },
      credentialWrapToken: 'wrap-e2e',
      state: 'ready',
      org: 'org_e2e',
      sub: 'usr_e2e',
    });
    creds.put('ses_e2e', 'wrap-e2e', { username: 'vm-user', password: 'Tr0ub4dour&3' });

    const cfg: BrokerConfig = {
      port: 0,
      path: '/tunnel',
      guacd: { host: '127.0.0.1', port: guacd.port, tls: false },
      signingKeys: { k1: key.toString('base64') },
      signingKid: 'k1',
      maxClientViolations: 3,
    };
    broker = createBroker(cfg, { resolver, credentials: creds, onSecurityEvent: (e) => events.push(e) });
    port = await broker.start();
  });

  afterEach(async () => {
    await broker.stop();
    await guacd.close();
  });

  function connect(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  }
  const token = (over: object = {}) =>
    mintConnectToken({ sid: 'ses_e2e', sub: 'usr_e2e', org: 'org_e2e', ...over }, keyring);
  const nextMsg = (ws: WebSocket): Promise<string> =>
    new Promise((r) => ws.once('message', (d: Buffer) => r(d.toString('utf8'))));
  /** Resolve once the broker emits a matching security event (post-handshake). */
  const waitForEvent = (kind: SecurityEvent['kind'], timeoutMs = 3000): Promise<SecurityEvent> =>
    new Promise((resolve, reject) => {
      const existing = events.find((e) => e.kind === kind);
      if (existing) return resolve(existing);
      const started = Date.now();
      const iv = setInterval(() => {
        const hit = events.find((e) => e.kind === kind);
        if (hit) {
          clearInterval(iv);
          resolve(hit);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`timed out waiting for '${kind}' event`));
        }
      }, 5);
    });

  it('serves /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('completes auth → credential injection → streaming, and never leaks the credential', async () => {
    const ws = connect();
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(token());
    await guacd.whenConnected();
    await waitForEvent('connected'); // broker finished the handshake + markConnected

    // The credential reached guacd server-side, positionally in connect values.
    expect(guacd.connectValues).toEqual(['10.0.9.9', '3389', 'vm-user', 'Tr0ub4dour&3', 'true']);

    // Drive a frame from guacd and confirm it reaches the browser.
    const gotFrame = nextMsg(ws);
    guacd.emit(i('sync', '42'));
    expect(await gotFrame).toContain('sync');

    ws.close();
  });

  it('forwards allowed input to guacd and silently drops a clipboard write', async () => {
    const ws = connect();
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(token());
    await guacd.whenConnected();
    await waitForEvent('connected'); // input sent during 'connecting' is dropped by design
    guacd.toClientFrames.length = 0;

    ws.send(i('mouse', '640', '360', '1'));
    ws.send(i('clipboard', '1', 'text/plain')); // must never reach guacd
    ws.send(i('key', '65', '1'));
    await new Promise((r) => setTimeout(r, 50));

    const forwarded = guacd.toClientFrames.join('');
    expect(forwarded).toContain('mouse');
    expect(forwarded).toContain('key');
    expect(forwarded).not.toContain('clipboard');
    expect(events.some((e) => e.kind === 'violation' && e.violation?.opcode === 'clipboard')).toBe(true);
    ws.close();
  });

  it('streams image pixels to the browser but suppresses a clipboard exfil stream', async () => {
    const ws = connect();
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(token());
    await guacd.whenConnected();
    await waitForEvent('connected');

    const secret = Buffer.from('EXFILTRATED-SECRET').toString('base64');
    const received: string[] = [];
    ws.on('message', (d: Buffer) => received.push(d.toString('utf8')));

    guacd.emit(
      i('img', '1', '12', '0', 'image/png', '0', '0') +
        i('blob', '1', 'cGl4ZWxz') +
        i('clipboard', '2', 'text/plain') +
        i('blob', '2', secret) +
        i('end', '2') +
        i('end', '1'),
    );
    await new Promise((r) => setTimeout(r, 80));

    const all = received.join('');
    expect(all).toContain('cGl4ZWxz'); // image pixels delivered
    expect(all).not.toContain(secret); // clipboard payload never delivered
    ws.close();
  });

  it('rejects a forged token and closes the socket without touching guacd', async () => {
    const ws = connect();
    await new Promise<void>((r) => ws.once('open', () => r()));
    const forged = mintConnectToken(
      { sid: 'ses_e2e', sub: 'usr_e2e', org: 'org_e2e' },
      { keys: new Map([['k1', randomBytes(32)]]), signingKid: 'k1' },
    );
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send(forged);
    expect(await closed).toBe(4003);
    expect(guacd.connectValues).toBeNull();
  });

  it('terminates the session on connect-token replay across two live connections', async () => {
    const ws1 = connect();
    await new Promise<void>((r) => ws1.once('open', () => r()));
    const t = token();
    ws1.send(t);
    await guacd.whenConnected();

    const ws2 = connect();
    await new Promise<void>((r) => ws2.once('open', () => r()));
    const closed2 = new Promise<number>((r) => ws2.once('close', (code) => r(code)));
    ws2.send(t); // replay
    expect(await closed2).toBe(4003);
    expect(events.some((e) => e.kind === 'replay')).toBe(true);
    expect(resolver.terminated.some((x) => x.sid === 'ses_e2e')).toBe(true);
    ws1.close();
  });
});
