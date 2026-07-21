import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GuacParser } from '../src/guac/parser.js';
import { formatInstruction } from '../src/guac/serialize.js';
import {
  buildConnectValues,
  buildProtocolParams,
  GuacdClient,
  GuacdHandshakeError,
} from '../src/protocol/guacd-client.js';
import type { SessionCredential, SessionTarget } from '../src/protocol/adapter.js';

const target: SessionTarget = {
  sid: 'ses_1',
  protocol: 'rdp',
  host: '10.0.1.5',
  port: 3389,
  width: 1920,
  height: 1080,
  dpi: 96,
};
const credential: SessionCredential = { username: 'session-user', password: 'S3cr3t-P@ss' };

describe('buildProtocolParams / buildConnectValues', () => {
  it('injects credentials and pixel-only lockdown flags', () => {
    const params = buildProtocolParams(target, credential);
    expect(params['hostname']).toBe('10.0.1.5');
    expect(params['username']).toBe('session-user');
    expect(params['password']).toBe('S3cr3t-P@ss');
    expect(params['disable-copy']).toBe('true');
    expect(params['disable-paste']).toBe('true');
    expect(params['enable-drive']).toBe('false');
    expect(params['enable-printing']).toBe('false');
    expect(params['disable-upload']).toBe('true');
  });

  it('positionally maps values to the arg names guacd requested', () => {
    const params = buildProtocolParams(target, credential);
    const argNames = ['hostname', 'port', 'username', 'password', 'disable-copy', 'unknown-param'];
    expect(buildConnectValues(argNames, params)).toEqual([
      '10.0.1.5',
      '3389',
      'session-user',
      'S3cr3t-P@ss',
      'true',
      '', // unknown params become empty, never undefined
    ]);
  });

  it('adds recording params only when recording is configured', () => {
    expect(buildProtocolParams(target, credential)['recording-path']).toBeUndefined();
    const rec = buildProtocolParams(
      { ...target, recording: { path: '/recordings/ses_1', name: 'rec' } },
      credential,
    );
    expect(rec['recording-path']).toBe('/recordings/ses_1');
    expect(rec['create-recording-path']).toBe('true');
  });
});

/**
 * A mock guacd that plays the server side of the handshake. Captures what the
 * client sends so tests can assert the credential was injected server-side.
 */
class MockGuacd {
  server: Server;
  port = 0;
  lastConnect: string[] | null = null;
  lastSelect: string | null = null;
  private behavior: 'ok' | 'error_on_connect' | 'error_immediately' | 'hang';
  private readonly sockets = new Set<Socket>();

  constructor(behavior: MockGuacd['behavior'] = 'ok') {
    this.behavior = behavior;
    this.server = createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      this.handle(sock);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(sock: Socket): void {
    if (this.behavior === 'error_immediately') {
      sock.write(formatInstruction('error', 'boom', '512'));
      return;
    }
    if (this.behavior === 'hang') return;
    const parser = new GuacParser();
    sock.on('data', (buf) => {
      for (const instr of parser.push(buf.toString('utf8'))) {
        if (instr.opcode === 'select') {
          this.lastSelect = instr.args[0] ?? null;
          // Ask for a canonical RDP-ish arg set.
          sock.write(
            formatInstruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'username', 'password', 'disable-copy'),
          );
        } else if (instr.opcode === 'connect') {
          this.lastConnect = instr.args;
          if (this.behavior === 'error_on_connect') {
            sock.write(formatInstruction('error', 'auth failed', '769'));
          } else {
            sock.write(formatInstruction('ready', '$260d01da-0000-4000-8000-000000000001'));
            // Immediately push a frame to exercise post-ready leftover handling.
            sock.write(formatInstruction('sync', '0'));
          }
        }
      }
    });
  }
}

describe('GuacdClient handshake', () => {
  let mock: MockGuacd;
  afterEach(async () => {
    await mock?.close();
  });

  it('completes the handshake and returns the connection id', async () => {
    mock = new MockGuacd('ok');
    await mock.listen();
    const client = new GuacdClient({ endpoint: { host: '127.0.0.1', port: mock.port, tls: false } });
    const conn = await client.open(target, credential);
    expect(conn.connectionId).toMatch(/^\$/);
    expect(mock.lastSelect).toBe('rdp');
    conn.close('done');
  });

  it('injects the credential into connect values server-side (never toward client)', async () => {
    mock = new MockGuacd('ok');
    await mock.listen();
    const client = new GuacdClient({ endpoint: { host: '127.0.0.1', port: mock.port, tls: false } });
    const conn = await client.open(target, credential);
    // args were [hostname, port, username, password, disable-copy]
    expect(mock.lastConnect).toEqual(['10.0.1.5', '3389', 'session-user', 'S3cr3t-P@ss', 'true']);
    conn.close('done');
  });

  it('delivers post-ready bytes to the caller (no frame loss at handoff)', async () => {
    mock = new MockGuacd('ok');
    await mock.listen();
    const client = new GuacdClient({ endpoint: { host: '127.0.0.1', port: mock.port, tls: false } });
    const conn = await client.open(target, credential);
    const received = await new Promise<string>((resolve) => {
      conn.onData((chunk) => resolve(chunk));
    });
    expect(received).toContain('sync');
    conn.close('done');
  });

  it('rejects when guacd errors during connect', async () => {
    mock = new MockGuacd('error_on_connect');
    await mock.listen();
    const client = new GuacdClient({ endpoint: { host: '127.0.0.1', port: mock.port, tls: false } });
    await expect(client.open(target, credential)).rejects.toBeInstanceOf(GuacdHandshakeError);
  });

  it('rejects on an immediate guacd error', async () => {
    mock = new MockGuacd('error_immediately');
    await mock.listen();
    const client = new GuacdClient({ endpoint: { host: '127.0.0.1', port: mock.port, tls: false } });
    await expect(client.open(target, credential)).rejects.toBeInstanceOf(GuacdHandshakeError);
  });

  it('times out on a hung guacd', async () => {
    mock = new MockGuacd('hang');
    await mock.listen();
    const client = new GuacdClient({
      endpoint: { host: '127.0.0.1', port: mock.port, tls: false },
      handshakeTimeoutMs: 150,
    });
    await expect(client.open(target, credential)).rejects.toThrow(/timed out/);
  });
});
