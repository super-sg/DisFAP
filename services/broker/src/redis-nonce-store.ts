/**
 * Redis-backed single-use nonce (jti) burn list.
 *
 * Why this exists: the in-memory store is per-process. A broker restart — a
 * deploy, or the second node of a multi-node deployment — forgets every burned
 * jti, which re-opens the replay window for any connect token that leaked and
 * has not yet expired (60 s). The deployment already provisions Redis for
 * exactly this, so this adapter makes `REDIS_URL` real.
 *
 * Semantics: `SET key 1 NX EX <ttl>` is a single atomic round-trip. A nil reply
 * means the key already existed ⇒ not first use ⇒ replay. Every failure (connect
 * refused, timeout, AUTH error, malformed reply) throws: the caller fails closed
 * rather than treating an unreachable store as "first use".
 *
 * Transport: `redis://` or `rediss://` (TLS with normal certificate
 * verification; mount a private CA and set `NODE_EXTRA_CA_CERTS` when needed).
 * Only OPEN, AUTH, SELECT and SET are spoken — not a general-purpose client.
 *
 * Validation status: unit-tested against a minimal RESP test server. It has NOT
 * been run against a real Redis instance in this environment (no Docker daemon).
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { NonceStore } from './nonce-store.js';

export interface RedisNonceStoreOptions {
  url: string;
  /** TCP/TLS connect timeout. Default 2000 ms. */
  connectTimeoutMs?: number;
  /** Per-command timeout. Default 2000 ms. */
  commandTimeoutMs?: number;
}

/** A RESP error reply (`-ERR ...`) — always a failure for our commands. */
class RedisReplyError extends Error {
  constructor(message: string) {
    super(`redis: ${message}`);
    this.name = 'RedisReplyError';
  }
}

type RedisReply = string | number | null;

/** `*<n>\r\n` + `$<len>\r\n<arg>\r\n` for every argument. */
function encodeCommand(args: string[]): Buffer {
  const out: string[] = [`*${args.length}\r\n`];
  for (const arg of args) out.push(`$${Buffer.byteLength(arg, 'utf8')}\r\n${arg}\r\n`);
  return Buffer.from(out.join(''), 'utf8');
}

/**
 * Parse one reply from the front of `buf`. Returns null when the buffer does not
 * yet hold a complete reply. Throws on an error reply or an unknown type byte.
 */
function parseReply(buf: Buffer): { reply: RedisReply; length: number } | null {
  if (buf.length === 0) return null;
  const lineEnd = buf.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buf[0] as number);
  const line = buf.subarray(1, lineEnd).toString('utf8');

  switch (type) {
    case '+':
      return { reply: line, length: lineEnd + 2 };
    case '-':
      throw new RedisReplyError(line);
    case ':':
      return { reply: Number(line), length: lineEnd + 2 };
    case '$': {
      const len = Number(line);
      if (!Number.isInteger(len) || len < -1) throw new RedisReplyError('malformed bulk reply');
      if (len === -1) return { reply: null, length: lineEnd + 2 };
      const start = lineEnd + 2;
      if (buf.length < start + len + 2) return null;
      return { reply: buf.subarray(start, start + len).toString('utf8'), length: start + len + 2 };
    }
    default:
      throw new RedisReplyError('unexpected reply type');
  }
}

/**
 * A single Redis connection that serializes commands. Created per operation: a
 * tunnel connect is not a hot loop, and a fresh socket means a stale connection
 * can never fail a later command.
 */
class RedisConnection {
  private buffer = Buffer.alloc(0);
  private readonly pending: Array<{ resolve: (v: RedisReply) => void; reject: (e: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly commandTimeoutMs: number,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('error', () => this.fail(new Error('redis: connection error')));
    socket.on('close', () => this.fail(new Error('redis: connection closed')));
  }

  private drain(): void {
    while (this.pending.length > 0) {
      let parsed: { reply: RedisReply; length: number } | null;
      try {
        parsed = parseReply(this.buffer);
      } catch (err) {
        this.fail(err as Error);
        return;
      }
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.length);
      this.pending.shift()?.resolve(parsed.reply);
    }
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    while (this.pending.length > 0) this.pending.shift()?.reject(this.failure);
    this.socket.destroy();
  }

  async command(args: string[]): Promise<RedisReply> {
    if (this.failure) throw this.failure;
    const reply = new Promise<RedisReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('redis: command timed out'));
      }, this.commandTimeoutMs);
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.pending.push({
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
      });
    });
    this.socket.write(encodeCommand(args));
    return reply;
  }

  close(): void {
    this.socket.destroy();
  }
}

export class RedisNonceStore implements NonceStore {
  private readonly tls: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly username?: string;
  private readonly password?: string;
  private readonly db?: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  /** Namespace so a shared Redis cannot collide with another application's keys. */
  private readonly prefix: string;

  constructor(opts: RedisNonceStoreOptions) {
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new Error('REDIS_URL must be a redis:// or rediss:// URL');
    }
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error('REDIS_URL must use redis:// or rediss://');
    }
    if (!url.hostname) throw new Error('REDIS_URL must name a host');
    this.tls = url.protocol === 'rediss:';
    this.host = url.hostname;
    this.port = url.port ? Number(url.port) : 6379;
    if (!Number.isInteger(this.port) || this.port <= 0 || this.port > 65_535) {
      throw new Error('REDIS_URL has an invalid port');
    }
    if (url.username) this.username = decodeURIComponent(url.username);
    if (url.password) this.password = decodeURIComponent(url.password);
    const db = url.pathname.replace(/^\//, '');
    if (db) {
      if (!/^\d+$/.test(db)) throw new Error('REDIS_URL database must be numeric');
      this.db = db;
    }
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 2_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 2_000;
    this.prefix = 'dfap:nonce:';
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.tls
        ? tlsConnect({ host: this.host, port: this.port, servername: this.host })
        : netConnect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('redis: connect timed out'));
      }, this.connectTimeoutMs);
      const ready = this.tls ? 'secureConnect' : 'connect';
      socket.once(ready, () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(socket);
      });
      const onError = (): void => {
        clearTimeout(timer);
        reject(new Error('redis: connect failed'));
      };
      socket.once('error', onError);
    });
  }

  async burn(key: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('redis: ttl must be a positive number');
    }
    const socket = await this.connect();
    const conn = new RedisConnection(socket, this.commandTimeoutMs);
    try {
      if (this.password) {
        const auth = this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password];
        const reply = await conn.command(auth);
        if (reply !== 'OK') throw new Error('redis: authentication rejected');
      }
      if (this.db) await conn.command(['SELECT', this.db]);

      const reply = await conn.command(['SET', `${this.prefix}${key}`, '1', 'NX', 'EX', String(Math.ceil(ttlSeconds))]);
      if (reply === null) return false; // NX: key already existed ⇒ replay
      if (reply !== 'OK') throw new Error('redis: unexpected SET reply');
      return true;
    } finally {
      conn.close();
    }
  }
}
