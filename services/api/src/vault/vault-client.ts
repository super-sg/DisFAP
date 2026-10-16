/**
 * VaultClient — the seam over HashiCorp Vault's KV + response-wrapping.
 *
 * The control plane writes a per-session credential to a short-TTL KV path and
 * hands the broker a *response-wrapped* token: a single-use handle the broker
 * unwraps exactly once at connect time to read the secret. A second unwrap
 * fails, which is itself a tamper signal. The credential therefore never lives
 * in Postgres and never crosses the wire to the browser.
 *
 *  - `FakeVaultClient`: in-memory, honours single-use unwrap + TTL. Tests/Phase-0.
 *  - `HttpVaultClient`: real KV v2 + response-wrapping over Vault's HTTP API
 *    (timeouts, namespace, no secret/token logging). Tested against a mock
 *    Vault server; NOT yet validated against a real Vault cluster.
 */

import { randomBytes } from 'node:crypto';

export interface WrappedSecret {
  wrapToken: string;
  expiresAt: Date;
}

export interface UnwrappedSecret {
  path: string;
  data: Record<string, string>;
}

export interface VaultClient {
  /**
   * Write `data` to `path` with `ttlSeconds`, then return a single-use
   * response-wrapped token that reads it back exactly once.
   */
  writeWrappedSecret(path: string, data: Record<string, string>, ttlSeconds: number): Promise<WrappedSecret>;
  /** Consume a wrap token; throws if already used, expired, or unknown. */
  unwrap(wrapToken: string): Promise<UnwrappedSecret>;
  /** Best-effort revoke of a session's secret on teardown (idempotent). */
  revoke(path: string): Promise<void>;
  /**
   * Read a secret by path with the API's OWN token (a server-side read, not a
   * single-use unwrap). Returns null when the path is absent or expired. Used
   * by the guest credential source to re-read the session credential at
   * provisioning time without consuming the broker's single-use wrap token.
   */
  read(path: string): Promise<Record<string, string> | null>;
}

export class WrapTokenConsumedError extends Error {
  constructor() {
    super('vault wrap token already consumed, expired, or unknown');
    this.name = 'WrapTokenConsumedError';
  }
}

// ---------------------------------------------------------------------------
// FakeVaultClient
// ---------------------------------------------------------------------------

interface FakeEntry {
  path: string;
  data: Record<string, string>;
  expiresAtMs: number;
  used: boolean;
}

export class FakeVaultClient implements VaultClient {
  private readonly wraps = new Map<string, FakeEntry>();
  private readonly kv = new Map<string, { data: Record<string, string>; expiresAtMs: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async writeWrappedSecret(path: string, data: Record<string, string>, ttlSeconds: number): Promise<WrappedSecret> {
    const expiresAtMs = this.now() + ttlSeconds * 1000;
    this.kv.set(path, { data: { ...data }, expiresAtMs });
    const wrapToken = `s.fake.${randomBytes(18).toString('hex')}`;
    this.wraps.set(wrapToken, { path, data: { ...data }, expiresAtMs, used: false });
    return { wrapToken, expiresAt: new Date(expiresAtMs) };
  }

  async unwrap(wrapToken: string): Promise<UnwrappedSecret> {
    const entry = this.wraps.get(wrapToken);
    if (!entry || entry.used || entry.expiresAtMs <= this.now()) throw new WrapTokenConsumedError();
    entry.used = true; // single-use
    return { path: entry.path, data: { ...entry.data } };
  }

  async revoke(path: string): Promise<void> {
    this.kv.delete(path);
    for (const [token, entry] of this.wraps) if (entry.path === path) this.wraps.delete(token);
  }

  async read(path: string): Promise<Record<string, string> | null> {
    const entry = this.kv.get(path);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.kv.delete(path);
      return null;
    }
    return { ...entry.data };
  }
}

// ---------------------------------------------------------------------------
// HttpVaultClient — real KV v2 + response-wrapping adapter
// ---------------------------------------------------------------------------

export interface HttpVaultOptions {
  addr: string; // e.g. https://vault.internal:8200
  token: string; // the API's OWN Vault token (from AppRole/IAM auth) — least privilege
  mount?: string; // KV v2 mount, default "secret"
  namespace?: string; // Vault Enterprise namespace (optional)
  /** Per-request timeout in ms. Default 5000. */
  requestTimeoutMs?: number;
  /** Fetch implementation — injectable so tests never open a socket. */
  fetchImpl?: typeof fetch;
}

/** A Vault HTTP call failed. Carries only a status — never a token or body. */
export class VaultRequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'VaultRequestError';
    if (status !== undefined) this.status = status;
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Real HTTP adapter over HashiCorp Vault's KV v2 + response-wrapping.
 *
 *  - The API's own token is used for writes/revokes (never a client-supplied
 *    token); the single-use wrap token is used ONLY for unwrap.
 *  - `X-Vault-Wrap-TTL` makes Vault return `wrap_info.token` instead of the
 *    data, so the secret never returns to the caller at write time.
 *  - Requests are time-bounded. Errors carry a status only — a secret value or
 *    a token is never placed in an error message (or a log line).
 *
 * Unit-tested against a mock Vault HTTP server. It has NOT been exercised
 * against a real Vault cluster; do not treat it as validated production Vault.
 */
export class HttpVaultClient implements VaultClient {
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly namespace?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpVaultOptions) {
    if (!opts.addr) throw new VaultRequestError('vault addr is required');
    if (!opts.token) throw new VaultRequestError('vault token is required');
    this.addr = opts.addr.replace(/\/+$/, '');
    this.token = opts.token;
    this.mount = opts.mount ?? 'secret';
    this.timeoutMs = opts.requestTimeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.namespace) this.namespace = opts.namespace;
  }

  private async send(url: string, init: RequestInit, token: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-Vault-Token': token,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;
    try {
      return await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new VaultRequestError('vault request timed out');
      }
      throw new VaultRequestError('vault request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private async jsonBody(res: Response): Promise<Record<string, unknown>> {
    try {
      return asRecord(await res.json());
    } catch {
      return {};
    }
  }

  async writeWrappedSecret(path: string, data: Record<string, string>, ttlSeconds: number): Promise<WrappedSecret> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new VaultRequestError('vault wrap ttl must be a positive number');
    }
    const res = await this.send(
      `${this.addr}/v1/${this.mount}/data/${path}`,
      {
        method: 'POST',
        headers: { 'X-Vault-Wrap-TTL': String(ttlSeconds), 'X-Vault-Request': 'true' },
        body: JSON.stringify({ data }),
      },
      this.token,
    );
    if (!res.ok) throw new VaultRequestError(`vault write failed (${res.status})`, res.status);
    const wrapInfo = asRecord((await this.jsonBody(res))['wrap_info']);
    const token = wrapInfo['token'];
    if (typeof token !== 'string' || token === '') {
      throw new VaultRequestError('vault did not return a wrap token');
    }
    const ttlRaw = wrapInfo['ttl'];
    const ttl = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : ttlSeconds;
    return { wrapToken: token, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async unwrap(wrapToken: string): Promise<UnwrappedSecret> {
    if (!wrapToken) throw new WrapTokenConsumedError();
    const res = await this.send(
      `${this.addr}/v1/sys/wrapping/unwrap`,
      { method: 'POST', headers: { 'X-Vault-Token': wrapToken } },
      wrapToken,
    );
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      throw new WrapTokenConsumedError();
    }
    if (!res.ok) throw new VaultRequestError(`vault unwrap failed (${res.status})`, res.status);

    const payload = asRecord((await this.jsonBody(res))['data']);
    // A KV v2 write response wraps the value one level deep: { data, metadata }.
    const kv = 'data' in payload ? asRecord(payload['data']) : payload;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(kv)) if (typeof v === 'string') out[k] = v;
    const metaPath = asRecord(payload['metadata'])['path'];
    return { path: typeof metaPath === 'string' ? metaPath : 'unknown', data: out };
  }

  async revoke(path: string): Promise<void> {
    const res = await this.send(`${this.addr}/v1/${this.mount}/metadata/${path}`, { method: 'DELETE' }, this.token);
    // 404 ⇒ already gone (idempotent). Anything else is a real, retryable error.
    if (!res.ok && res.status !== 404) {
      throw new VaultRequestError(`vault revoke failed (${res.status})`, res.status);
    }
  }

  async read(path: string): Promise<Record<string, string> | null> {
    const res = await this.send(`${this.addr}/v1/${this.mount}/data/${path}`, { method: 'GET' }, this.token);
    if (res.status === 404) return null;
    if (!res.ok) throw new VaultRequestError(`vault read failed (${res.status})`, res.status);
    const payload = asRecord((await this.jsonBody(res))['data']);
    // KV v2 read wraps the value: { data: { data, metadata } }.
    const kv = 'data' in payload ? asRecord(payload['data']) : payload;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(kv)) if (typeof v === 'string') out[k] = v;
    return out;
  }
}
