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

import { VaultRequestError, WrapTokenConsumedError } from './errors.js';
import { StaticTokenSource, type VaultTokenSource } from './vault-auth.js';

// Re-exported so existing importers keep one import surface for the client.
export { VaultAuthError, VaultRequestError, WrapTokenConsumedError } from './errors.js';

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
  /**
   * Wrap a READ of an existing secret, without writing it and without ever
   * returning its plaintext to this process.
   *
   * This is the re-issuance primitive: Vault itself turns a KV read into a
   * fresh single-use `wrap_info.token`, so a reconnecting client gets a new
   * one-time handle while the credential stays in Vault. Returns null when the
   * path no longer exists (revoked or expired), which the caller must treat as
   * "no connection handle" — never as "connect without a credential".
   */
  wrapExistingSecret(path: string, ttlSeconds: number): Promise<WrappedSecret | null>;
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

/**
 * A KV path under the configured mount, restricted to plain segments.
 *
 * Paths are built from server-side ids, but they are interpolated into URLs and
 * into a DELETE of `metadata/<path>` — a caller that ever supplied a `sid` with
 * `..`, a leading slash, or an encoded separator could address (or destroy)
 * another secret. Restricting to `[A-Za-z0-9._-]` per segment, first character
 * alphanumeric, makes `..` and `/`-escape impossible in one place.
 */
export function assertSafeSecretPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
    throw new VaultRequestError('vault path is invalid');
  }
  const segments = path.split('/');
  if (segments.length > 8) throw new VaultRequestError('vault path is too deep');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..') {
      throw new VaultRequestError('vault path is invalid');
    }
  }
  return path;
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
    assertSafeSecretPath(path);
    const expiresAtMs = this.now() + ttlSeconds * 1000;
    this.kv.set(path, { data: { ...data }, expiresAtMs });
    const wrapToken = `s.fake.${randomBytes(18).toString('hex')}`;
    this.wraps.set(wrapToken, { path, data: { ...data }, expiresAtMs, used: false });
    return { wrapToken, expiresAt: new Date(expiresAtMs) };
  }

  async wrapExistingSecret(path: string, ttlSeconds: number): Promise<WrappedSecret | null> {
    assertSafeSecretPath(path);
    const stored = this.kv.get(path);
    if (!stored) return null;
    if (stored.expiresAtMs <= this.now()) {
      this.kv.delete(path);
      return null;
    }
    // The handle cannot outlive the underlying secret.
    const expiresAtMs = Math.min(stored.expiresAtMs, this.now() + ttlSeconds * 1000);
    const wrapToken = `s.fake.${randomBytes(18).toString('hex')}`;
    this.wraps.set(wrapToken, { path, data: { ...stored.data }, expiresAtMs, used: false });
    return { wrapToken, expiresAt: new Date(expiresAtMs) };
  }

  async unwrap(wrapToken: string): Promise<UnwrappedSecret> {
    const entry = this.wraps.get(wrapToken);
    if (!entry || entry.used || entry.expiresAtMs <= this.now()) throw new WrapTokenConsumedError();
    entry.used = true; // single-use
    return { path: entry.path, data: { ...entry.data } };
  }

  async revoke(path: string): Promise<void> {
    assertSafeSecretPath(path);
    this.kv.delete(path);
    for (const [token, entry] of this.wraps) if (entry.path === path) this.wraps.delete(token);
  }

  async read(path: string): Promise<Record<string, string> | null> {
    assertSafeSecretPath(path);
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
  /**
   * The API's OWN Vault credential — least privilege, never root.
   *
   * Either a static token (long-lived; supplied via `VAULT_TOKEN` /
   * `VAULT_TOKEN_FILE`) or a `VaultTokenSource` such as `AppRoleTokenSource`,
   * which logs in and refreshes short-lived tokens itself.
   */
  token?: string;
  tokenSource?: VaultTokenSource;
  mount?: string; // KV v2 mount, default "secret"
  namespace?: string; // Vault Enterprise namespace (optional)
  /** Per-request timeout in ms. Default 5000. */
  requestTimeoutMs?: number;
  /** Fetch implementation — injectable so tests never open a socket. */
  fetchImpl?: typeof fetch;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Real HTTP adapter over HashiCorp Vault's KV v2 + response-wrapping.
 *
 *  - The API's own credential is used for writes/revokes/reads (never a
 *    client-supplied token); the single-use wrap token is used ONLY for unwrap.
 *  - `X-Vault-Wrap-TTL` makes Vault return `wrap_info.token` instead of the
 *    data, so the secret never returns to the caller at write time.
 *  - A 403 invalidates a refreshable token and retries the request exactly once,
 *    so an expired AppRole lease is not a user-visible failure — but a policy
 *    denial (which re-fails) still surfaces as an error.
 *  - Requests are time-bounded. Errors carry a status only — a secret value or
 *    a token is never placed in an error message (or a log line).
 *
 * Unit-tested against a mock Vault HTTP server. It has NOT been exercised
 * against a real Vault cluster; do not treat it as validated production Vault.
 */
export class HttpVaultClient implements VaultClient {
  private readonly addr: string;
  private readonly tokens: VaultTokenSource;
  private readonly mount: string;
  private readonly namespace?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpVaultOptions) {
    if (!opts.addr) throw new VaultRequestError('vault addr is required');
    if (!opts.token && !opts.tokenSource) throw new VaultRequestError('vault token is required');
    if (opts.token && opts.tokenSource) {
      throw new VaultRequestError('configure either a vault token or a token source, not both');
    }
    this.addr = opts.addr.replace(/\/+$/, '');
    this.tokens = opts.tokenSource ?? new StaticTokenSource(opts.token ?? '');
    this.mount = opts.mount ?? 'secret';
    this.timeoutMs = opts.requestTimeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.namespace) this.namespace = opts.namespace;
  }

  /**
   * Send a request with the service's own credential. A 403 triggers one
   * re-authentication: an AppRole token that expired between `get()` and the
   * request would otherwise fail spuriously. A static token cannot change, so
   * the retry is skipped and the original 403 is returned.
   */
  private async authedSend(url: string, init: RequestInit): Promise<Response> {
    const token = await this.tokens.get();
    const res = await this.send(url, init, token);
    if (res.status === 403) {
      this.tokens.invalidate();
      const fresh = await this.tokens.get();
      if (fresh !== token) return this.send(url, init, fresh);
    }
    return res;
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
    assertSafeSecretPath(path);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new VaultRequestError('vault wrap ttl must be a positive number');
    }
    const res = await this.authedSend(`${this.addr}/v1/${this.mount}/data/${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Wrap-TTL': String(ttlSeconds), 'X-Vault-Request': 'true' },
      body: JSON.stringify({ data }),
    });
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

  /**
   * `GET` the KV path with `X-Vault-Wrap-TTL`: Vault returns `wrap_info` and
   * never the secret, so re-issuing a handle does not pull plaintext into the
   * control plane. A 404 means the session secret is gone (revoked/expired).
   */
  async wrapExistingSecret(path: string, ttlSeconds: number): Promise<WrappedSecret | null> {
    assertSafeSecretPath(path);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new VaultRequestError('vault wrap ttl must be a positive number');
    }
    const res = await this.authedSend(`${this.addr}/v1/${this.mount}/data/${path}`, {
      method: 'GET',
      headers: { 'X-Vault-Wrap-TTL': String(ttlSeconds), 'X-Vault-Request': 'true' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new VaultRequestError(`vault read failed (${res.status})`, res.status);
    const body = await this.jsonBody(res);
    const wrapInfo = asRecord(body['wrap_info']);
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
    // Deliberately NOT `authedSend`: the wrap token IS the credential here, and
    // it must never be replaced by (or confused with) the service's own token.
    const res = await this.send(`${this.addr}/v1/sys/wrapping/unwrap`, { method: 'POST' }, wrapToken);
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
    assertSafeSecretPath(path);
    const res = await this.authedSend(`${this.addr}/v1/${this.mount}/metadata/${path}`, { method: 'DELETE' });
    // 404 ⇒ already gone (idempotent). Anything else is a real, retryable error.
    if (!res.ok && res.status !== 404) {
      throw new VaultRequestError(`vault revoke failed (${res.status})`, res.status);
    }
  }

  async read(path: string): Promise<Record<string, string> | null> {
    assertSafeSecretPath(path);
    const res = await this.authedSend(`${this.addr}/v1/${this.mount}/data/${path}`, { method: 'GET' });
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
