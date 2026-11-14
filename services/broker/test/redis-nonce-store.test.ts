import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { RedisNonceStore } from '../src/redis-nonce-store.js';
import { InMemoryNonceStore } from '../src/nonce-store.js';

/**
 * A deliberately tiny RESP server: enough to exercise AUTH, SELECT and
 * `SET ... NX EX`, and to fail in the ways a real Redis can. It is NOT Redis —
 * passing here is not evidence that the adapter works against a real server.
 */
class FakeRedis {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  readonly keys = new Map<string, string>();
  readonly commands: string[][] = [];
  password: string | null = null;
  setReply: string | null = null;
  port = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = FakeRedis.parseCommand(buf);
          if (!parsed) return;
          buf = buf.subarray(parsed.length);
          this.handle(socket, parsed.args);
        }
      });
    });
  }

  private static parseCommand(buf: Buffer): { args: string[]; length: number } | null {
    if (buf.length === 0 || String.fromCharCode(buf[0] as number) !== '*') return null;
    const headerEnd = buf.indexOf('\r\n');
    if (headerEnd < 0) return null;
    const count = Number(buf.subarray(1, headerEnd).toString('utf8'));
    let offset = headerEnd + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const lineEnd = buf.indexOf('\r\n', offset);
      if (lineEnd < 0) return null;
      const len = Number(buf.subarray(offset + 1, lineEnd).toString('utf8'));
      const start = lineEnd + 2;
      if (buf.length < start + len + 2) return null;
      args.push(buf.subarray(start, start + len).toString('utf8'));
      offset = start + len + 2;
    }
    return { args, length: offset };
  }

  private handle(socket: Socket, args: string[]): void {
    this.commands.push(args);
    const cmd = (args[0] ?? '').toUpperCase();
    if (cmd === 'AUTH') {
      const provided = args[1] === 'default' ? args[2] : args[1];
      if (this.password && provided === this.password) socket.write('+OK\r\n');
      else socket.write('-WRONGPASS invalid username-password pair\r\n');
      return;
    }
    if (cmd === 'SELECT') {
      socket.write('+OK\r\n');
      return;
    }
    if (cmd === 'SET') {
      if (this.setReply) {
        socket.write(this.setReply);
        return;
      }
      const key = args[1] ?? '';
      const nx = args.includes('NX');
      if (nx && this.keys.has(key)) {
        socket.write('$-1\r\n');
        return;
      }
      this.keys.set(key, args[2] ?? '');
      socket.write('+OK\r\n');
      return;
    }
    socket.write('-ERR unknown command\r\n');
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const open: FakeRedis[] = [];
async function fakeRedis(): Promise<FakeRedis> {
  const server = new FakeRedis();
  await server.start();
  open.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('RedisNonceStore — single-use semantics', () => {
  it('burns a key once and reports a replay the second time', async () => {
    const redis = await fakeRedis();
    const store = new RedisNonceStore({ url: redis.url });

    await expect(store.burn('dfap:jti:abc', 90)).resolves.toBe(true);
    await expect(store.burn('dfap:jti:abc', 90)).resolves.toBe(false);
    await expect(store.burn('dfap:jti:def', 90)).resolves.toBe(true);

    const set = redis.commands.filter((c) => c[0] === 'SET')[0];
    expect(set).toEqual(['SET', 'dfap:nonce:dfap:jti:abc', '1', 'NX', 'EX', '90']);
  });

  it('sends AUTH and SELECT when the URL carries a password and database', async () => {
    const redis = await fakeRedis();
    redis.password = 'hunter2';
    const store = new RedisNonceStore({ url: `redis://:hunter2@127.0.0.1:${redis.port}/3` });
    await expect(store.burn('k', 60)).resolves.toBe(true);
    expect(redis.commands.map((c) => c[0])).toEqual(['AUTH', 'SELECT', 'SET']);
  });

  it('fails closed on a wrong password', async () => {
    const redis = await fakeRedis();
    redis.password = 'right';
    const store = new RedisNonceStore({ url: `redis://:wrong@127.0.0.1:${redis.port}` });
    await expect(store.burn('k', 60)).rejects.toThrow(/redis:/);
  });

  it('fails closed on an unexpected reply instead of guessing "first use"', async () => {
    const redis = await fakeRedis();
    redis.setReply = ':42\r\n';
    const store = new RedisNonceStore({ url: redis.url });
    await expect(store.burn('k', 60)).rejects.toThrow(/unexpected SET reply/);
  });

  it('fails closed when Redis is unreachable', async () => {
    const store = new RedisNonceStore({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 500 });
    await expect(store.burn('k', 60)).rejects.toThrow(/redis:/);
  });

  it('rejects a non-positive TTL before connecting', async () => {
    const store = new RedisNonceStore({ url: 'redis://127.0.0.1:1' });
    await expect(store.burn('k', 0)).rejects.toThrow(/ttl/);
  });

  it('validates the URL at construction', () => {
    expect(() => new RedisNonceStore({ url: 'http://localhost:6379' })).toThrow(/redis:\/\//);
    expect(() => new RedisNonceStore({ url: 'redis://host:notaport' })).toThrow(/redis:\/\//);
    expect(() => new RedisNonceStore({ url: 'redis://host/abc' })).toThrow(/numeric/);
  });
});

describe('InMemoryNonceStore — the reference semantics the Redis store mirrors', () => {
  it('is single-use and expires after its TTL', async () => {
    const store = new InMemoryNonceStore();
    await expect(store.burn('k', 1)).resolves.toBe(true);
    await expect(store.burn('k', 1)).resolves.toBe(false);
  });
});
