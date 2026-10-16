/**
 * A minimal, local mock of the pieces of Vault's HTTP API the control plane
 * uses: KV v2 write-with-wrap, `sys/wrapping/unwrap` (single-use), and metadata
 * delete. It exists so `HttpVaultClient` can be exercised over real HTTP without
 * a Vault cluster. It is NOT Vault: do not mistake passing against it for real
 * Vault integration.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface WrapEntry {
  path: string;
  data: Record<string, string>;
  expiresAtMs: number;
  used: boolean;
}

export interface SeenRequest {
  method: string;
  path: string;
  token?: string;
  namespace?: string;
  wrapTtl?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockVaultServer {
  private readonly server: Server;
  private readonly wraps = new Map<string, WrapEntry>();
  private readonly kv = new Map<string, Record<string, string>>();
  readonly seen: SeenRequest[] = [];

  /** Token the client must present for write/revoke (the API's own token). */
  requiredToken = 'root-token';
  /** When set, every response is this status (a forced failure). */
  failStatus: number | null = null;
  /** Artificial latency before responding, for timeout tests. */
  delayMs = 0;
  addr = '';

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.addr = `http://127.0.0.1:${port}`;
    return this.addr;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  has(path: string): boolean {
    return this.kv.has(path);
  }

  /** Force every outstanding wrap token to look expired. */
  expireAll(): void {
    for (const entry of this.wraps.values()) entry.expiresAtMs = 0;
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://vault');
    const token = req.headers['x-vault-token'] as string | undefined;
    const namespace = req.headers['x-vault-namespace'] as string | undefined;
    const wrapTtl = req.headers['x-vault-wrap-ttl'] as string | undefined;
    this.seen.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(token !== undefined ? { token } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
      ...(wrapTtl !== undefined ? { wrapTtl } : {}),
    });

    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.failStatus !== null) {
      this.send(res, this.failStatus, { errors: ['forced failure'] });
      return;
    }

    // POST /v1/sys/wrapping/unwrap — authenticated by the wrap token itself.
    if (req.method === 'POST' && url.pathname === '/v1/sys/wrapping/unwrap') {
      const entry = token ? this.wraps.get(token) : undefined;
      if (!entry || entry.used || entry.expiresAtMs <= Date.now()) {
        this.send(res, 403, { errors: ['permission denied'] });
        return;
      }
      entry.used = true;
      this.send(res, 200, { data: { data: entry.data, metadata: { path: entry.path } } });
      return;
    }

    // Everything else requires the API's own token.
    if (token !== this.requiredToken) {
      this.send(res, 403, { errors: ['permission denied'] });
      return;
    }

    const segs = url.pathname.split('/').filter(Boolean);

    // POST /v1/<mount>/data/<path...>
    if (req.method === 'POST' && segs[0] === 'v1' && segs[2] === 'data') {
      const path = segs.slice(3).join('/');
      const ttl = Number(wrapTtl ?? '0');
      const payload = await this.readBody(req);
      const data = (typeof payload['data'] === 'object' && payload['data'] !== null
        ? (payload['data'] as Record<string, string>)
        : {});
      this.kv.set(path, { ...data });
      const wrapToken = `s.mock.${randomBytes(8).toString('hex')}`;
      this.wraps.set(wrapToken, { path, data: { ...data }, expiresAtMs: Date.now() + ttl * 1000, used: false });
      this.send(res, 200, { wrap_info: { token: wrapToken, ttl } });
      return;
    }

    // DELETE /v1/<mount>/metadata/<path...>
    if (req.method === 'DELETE' && segs[0] === 'v1' && segs[2] === 'metadata') {
      this.kv.delete(segs.slice(3).join('/'));
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /v1/<mount>/data/<path...>  — server-side KV v2 read (API's own token).
    if (req.method === 'GET' && segs[0] === 'v1' && segs[2] === 'data') {
      const path = segs.slice(3).join('/');
      const data = this.kv.get(path);
      if (!data) {
        this.send(res, 404, { errors: ['not found'] });
        return;
      }
      this.send(res, 200, { data: { data: { ...data }, metadata: { path } } });
      return;
    }

    this.send(res, 404, { errors: ['not found'] });
  }
}
