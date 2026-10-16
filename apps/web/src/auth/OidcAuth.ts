/**
 * Browser OIDC session wrapper around `oidc-client-ts`.
 *
 * Responsibilities:
 *  - drive the Authorization Code + PKCE redirect (login initiation, callback
 *    processing, logout);
 *  - hand the API client a currently-valid **access token** (renewing on expiry),
 *    or `null` when the user is not authenticated — never a stale/expired token;
 *  - keep the client out of a misleadingly-authenticated state after a denied
 *    login, a callback error, or a failed renewal.
 *
 * The access token is NEVER decoded or treated as verified here. The browser can
 * read any JWT it holds, but only the API — which checks the signature, issuer,
 * audience and claims server-side — may act on it. This module only transports.
 */

import { createUserManager, type OidcSettings } from './oidc-settings.js';

/** The subset of `oidc-client-ts`'s `User` this module relies on. */
export interface OidcUserLike {
  access_token: string;
  expired?: boolean;
  /** Seconds since epoch (oidc-client-ts semantics). */
  expires_at?: number;
  /** The value we passed as `state` to `signinRedirect` (our return route). */
  state?: unknown;
  profile?: Record<string, unknown>;
}

/** The subset of `UserManager` we use — injectable for tests. */
export interface UserManagerLike {
  getUser(): Promise<OidcUserLike | null>;
  signinRedirect(args?: { state?: string; nonce?: string }): Promise<void>;
  signinRedirectCallback(url?: string): Promise<OidcUserLike>;
  signinSilent(): Promise<OidcUserLike | null>;
  signoutRedirect(args?: { post_logout_redirect_uri?: string }): Promise<void>;
  removeUser(): Promise<void>;
}

/** Minimal view of the browser location, injectable for tests. */
export interface BrowserLike {
  pathname: string;
  search: string;
  hash: string;
  /** Replace the current history entry (strips the callback query string). */
  replace(url: string): void;
}

export interface OidcAuthOptions {
  browser?: BrowserLike;
}

/** Renew this far ahead of expiry so a request never races the clock. */
const EXPIRY_SKEW_MS = 30_000;

function defaultBrowser(): BrowserLike {
  return {
    get pathname() {
      return window.location.pathname;
    },
    get search() {
      return window.location.search;
    },
    get hash() {
      return window.location.hash;
    },
    replace(url: string) {
      window.history.replaceState(null, '', url);
    },
  };
}

function isExpired(user: OidcUserLike): boolean {
  if (user.expired === true) return true;
  if (typeof user.expires_at === 'number') return user.expires_at * 1000 <= Date.now() + EXPIRY_SKEW_MS;
  return false;
}

/** Only in-app hash routes are accepted as return targets (no open redirect). */
function sanitizeReturnTo(value: string | undefined | null): string {
  if (typeof value === 'string' && /^#\/[\w\-/]*$/.test(value)) return value;
  return '#/';
}

/** A fresh anti-replay nonce for the authorization request. */
function randomNonce(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function describeCallbackError(err: unknown, params: URLSearchParams): string {
  const error = params.get('error');
  if (error === 'access_denied') return 'Sign-in was denied by the provider.';
  if (error) return `Sign-in failed (${error}).`;
  const message = err instanceof Error && err.message ? err.message : 'unknown error';
  return `Sign-in callback failed: ${message}`;
}

export class OidcAuth {
  private user: OidcUserLike | null = null;
  private failure: string | null = null;
  private readonly browser: BrowserLike;

  constructor(
    private readonly settings: OidcSettings,
    private readonly manager: UserManagerLike,
    opts: OidcAuthOptions = {},
  ) {
    this.browser = opts.browser ?? defaultBrowser();
  }

  /** True when the current URL is our OIDC redirect callback. */
  isCallbackRequest(): boolean {
    const redirectPath = new URL(this.settings.redirectUri).pathname;
    if (this.browser.pathname !== redirectPath) return false;
    const params = new URLSearchParams(this.browser.search);
    return params.has('code') || params.has('error') || params.has('state');
  }

  /**
   * Process the redirect callback if we are on it. Idempotent and never throws:
   * a failure is surfaced via `error()` and leaves the client unauthenticated.
   */
  async init(): Promise<void> {
    if (!this.isCallbackRequest()) return;
    const params = new URLSearchParams(this.browser.search);
    const returnTo = sanitizeReturnTo(params.get('state') ?? this.browser.hash);
    try {
      this.user = await this.manager.signinRedirectCallback(
        `${this.settings.redirectUri}${this.browser.search}`,
      );
      this.failure = null;
    } catch (err) {
      this.user = null;
      this.failure = describeCallbackError(err, params);
    } finally {
      // Strip ?code/state/error from the address bar regardless of outcome.
      this.browser.replace(`/${returnTo}`);
    }
  }

  /**
   * Begin login. `returnTo` must be an in-app hash route (defaults to current).
   * A fresh nonce is supplied so the library binds it to the authorization
   * request and validates it against the returned ID token.
   */
  async signin(returnTo?: string): Promise<void> {
    this.failure = null;
    await this.manager.signinRedirect({
      state: sanitizeReturnTo(returnTo ?? this.browser.hash),
      nonce: randomNonce(),
    });
  }

  /** Clear local session state, then best-effort RP-initiated provider logout. */
  async signout(): Promise<void> {
    this.user = null;
    try {
      await this.manager.removeUser();
    } catch {
      // Local clear already happened; nothing further to do.
    }
    if (this.settings.postLogoutRedirectUri) {
      try {
        await this.manager.signoutRedirect({
          post_logout_redirect_uri: this.settings.postLogoutRedirectUri,
        });
      } catch {
        // Provider may not support RP-initiated logout; local sign-out stands.
      }
    }
  }

  /**
   * A currently-valid access token, renewing once when expired. Returns `null`
   * (and drops local state) when there is no session or renewal fails, so the
   * API client never attaches a stale token and believes it is authenticated.
   */
  async getAccessToken(): Promise<string | null> {
    let user = this.user;
    if (!user) {
      try {
        user = await this.manager.getUser();
      } catch {
        user = null;
      }
    }
    if (!user) {
      this.user = null;
      return null;
    }
    if (isExpired(user)) {
      try {
        const renewed = await this.manager.signinSilent();
        if (!renewed) {
          this.user = null;
          return null;
        }
        user = renewed;
      } catch {
        this.user = null;
        return null;
      }
    }
    this.user = user;
    return user.access_token.length > 0 ? user.access_token : null;
  }

  isAuthenticated(): boolean {
    return this.user !== null && !isExpired(this.user);
  }

  /** Display-only (may be null). Never used for authorization. */
  displayName(): string | null {
    const email = this.user?.profile?.['email'];
    return typeof email === 'string' && email !== '' ? email : null;
  }

  /** The last callback/login error, if any. */
  error(): string | null {
    return this.failure;
  }
}

/** Build an `OidcAuth` wired to a real `UserManager`. */
export function createOidcAuth(settings: OidcSettings, opts: OidcAuthOptions = {}): OidcAuth {
  return new OidcAuth(settings, createUserManager(settings) as unknown as UserManagerLike, opts);
}
