/**
 * Vault authentication — how the control plane proves *who it is* to Vault.
 *
 * The application must never run with a Vault root or administrator token. Two
 * sources are supported:
 *
 *  - `StaticTokenSource` — a token supplied out of band (`VAULT_TOKEN` or
 *    `VAULT_TOKEN_FILE`). Simple, but long-lived: use it only when the platform
 *    cannot issue a workload identity, and give it a tightly scoped policy.
 *  - `AppRoleTokenSource` — the preferred path. The service holds a role_id and
 *    a secret_id (the latter from a file where possible), logs in to
 *    `auth/approle/login`, and uses the resulting short-lived token until just
 *    before it expires, then re-authenticates. A denied or expired token is
 *    invalidated and re-minted exactly once per request by the client.
 *
 * Neither source ever falls back to a default, an empty token, or an
 * unauthenticated request: failure is a hard error, so a call that needs a
 * secret cannot proceed.
 *
 * No token, role_id, secret_id, or response body is ever placed in an error
 * message or a log line.
 */

import { VaultAuthError } from './errors.js';

export interface VaultTokenSource {
  /** A currently-valid Vault token. Implementations cache and refresh. */
  get(): Promise<string>;
  /**
   * Forget any cached token. Called after a 403 so the next `get()` re-mints.
   * A no-op for a static token (the operator must rotate it).
   */
  invalidate(): void;
}

export class StaticTokenSource implements VaultTokenSource {
  constructor(private readonly token: string) {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new VaultAuthError('vault token is required');
    }
  }

  async get(): Promise<string> {
    return this.token;
  }

  invalidate(): void {
    // Nothing to do: a static token cannot be refreshed. A 403 stays a 403.
  }
}

export interface AppRoleOptions {
  /** Vault base address (no trailing slash), e.g. https://vault.internal:8200 */
  addr: string;
  roleId: string;
  secretId: string;
  namespace?: string;
  /** Per-request timeout for the login call. Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Inject a fetch implementation so unit tests never open a socket. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/** Refresh this long before the lease ends, so an in-flight request never races expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Upper bound on a cached login, even for a non-expiring lease. */
const MAX_CACHE_MS = 5 * 60_000;
/** Floor on a cached login, for a Vault that hands out very short leases. */
const MIN_CACHE_MS = 5_000;

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * AppRole login with caching and single-flight refresh.
 *
 * `secret_id` is reusable (created with `secret_id_num_uses=0`) because the
 * service re-authenticates for the life of the deployment; rotating it is an
 * operator action (see docs/security/secrets-management.md).
 */
export class AppRoleTokenSource implements VaultTokenSource {
  private readonly addr: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly namespace?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;
  /** Login attempts, exposed for tests/diagnostics (never a token). */
  loginCount = 0;

  constructor(opts: AppRoleOptions) {
    if (!opts.addr) throw new VaultAuthError('vault addr is required');
    if (!opts.roleId) throw new VaultAuthError('vault approle role_id is required');
    if (!opts.secretId) throw new VaultAuthError('vault approle secret_id is required');
    this.addr = opts.addr.replace(/\/+$/, '');
    this.roleId = opts.roleId;
    this.secretId = opts.secretId;
    this.timeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    if (opts.namespace) this.namespace = opts.namespace;
  }

  async get(): Promise<string> {
    const now = this.now();
    if (this.cached && now < this.cached.refreshAtMs) return this.cached.token;

    // Single-flight: concurrent callers share one login, so a burst of requests
    // after expiry cannot stampede Vault.
    this.inflight ??= this.login().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async login(): Promise<string> {
    this.loginCount += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.addr}/v1/auth/approle/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new VaultAuthError('vault approle login timed out');
      }
      throw new VaultAuthError('vault approle login failed');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Status only: the body may echo request metadata.
      throw new VaultAuthError(`vault approle login rejected (${res.status})`, res.status);
    }

    let body: Record<string, unknown>;
    try {
      body = asRecord(await res.json());
    } catch {
      throw new VaultAuthError('vault approle login returned a malformed response');
    }
    const auth = asRecord(body['auth']);
    const token = auth['client_token'];
    if (typeof token !== 'string' || token === '') {
      throw new VaultAuthError('vault approle login returned no client token');
    }
    const leaseRaw = auth['lease_duration'];
    const leaseMs = typeof leaseRaw === 'number' && Number.isFinite(leaseRaw) && leaseRaw > 0 ? leaseRaw * 1000 : 0;

    const now = this.now();
    const refreshAtMs =
      leaseMs === 0
        ? now + MAX_CACHE_MS
        : now + Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, leaseMs - REFRESH_SKEW_MS));

    this.cached = { token, refreshAtMs };
    return token;
  }
}
