import { webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// jsdom does not always expose WebCrypto; PKCE (S256) in oidc-client-ts needs
// `crypto.subtle`. Provide Node's implementation when it is missing.
if (!(globalThis.crypto as { subtle?: unknown } | undefined)?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { OidcClient, type OidcClientSettings } from 'oidc-client-ts';

import { ApiClient } from '../src/api/client.js';
import { OidcAuth, type BrowserLike, type OidcUserLike, type UserManagerLike } from '../src/auth/OidcAuth.js';
import { createUserManager, oidcSettingsFromEnv, type OidcSettings } from '../src/auth/oidc-settings.js';

const ORIGIN = 'http://localhost:5173';

const SETTINGS: OidcSettings = {
  issuer: 'https://idp.test/',
  clientId: 'disfap-web',
  scope: 'openid',
  audienceParam: 'audience',
  redirectUri: `${ORIGIN}/auth/callback`,
};

// ---------------------------------------------------------------------------
// Configuration parsing
// ---------------------------------------------------------------------------

describe('oidcSettingsFromEnv', () => {
  it('returns null when OIDC is not configured (local dev)', () => {
    expect(oidcSettingsFromEnv({}, ORIGIN)).toBeNull();
  });

  it('throws when exactly one of issuer/clientId is set (no silent half-config)', () => {
    expect(() => oidcSettingsFromEnv({ VITE_OIDC_ISSUER: 'https://idp.test' }, ORIGIN)).toThrow(/CLIENT_ID/);
    expect(() => oidcSettingsFromEnv({ VITE_OIDC_CLIENT_ID: 'web' }, ORIGIN)).toThrow(/ISSUER/);
  });

  it('applies defaults and derives an origin-absolute redirect URI', () => {
    const settings = oidcSettingsFromEnv(
      { VITE_OIDC_ISSUER: 'https://idp.test/', VITE_OIDC_CLIENT_ID: 'web' },
      ORIGIN,
    );
    expect(settings).not.toBeNull();
    expect(settings).toMatchObject({
      issuer: 'https://idp.test/',
      clientId: 'web',
      scope: 'openid profile email',
      audienceParam: 'audience',
      redirectUri: `${ORIGIN}/auth/callback`,
    });
    expect(settings!.audience).toBeUndefined();
    expect(settings!.postLogoutRedirectUri).toBeUndefined();
  });

  it('honours audience, scope, redirect path and post-logout redirect', () => {
    const settings = oidcSettingsFromEnv(
      {
        VITE_OIDC_ISSUER: 'https://idp.test/',
        VITE_OIDC_CLIENT_ID: 'web',
        VITE_OIDC_SCOPE: 'openid email',
        VITE_OIDC_AUDIENCE: 'https://api.disfap.test',
        VITE_OIDC_AUDIENCE_PARAM: 'resource',
        VITE_OIDC_REDIRECT_PATH: 'callback',
        VITE_OIDC_POST_LOGOUT_REDIRECT_URI: 'https://app.test/signed-out',
      },
      ORIGIN,
    )!;
    expect(settings.scope).toBe('openid email');
    expect(settings.audience).toBe('https://api.disfap.test');
    expect(settings.audienceParam).toBe('resource');
    expect(settings.redirectUri).toBe(`${ORIGIN}/callback`);
    expect(settings.postLogoutRedirectUri).toBe('https://app.test/signed-out');
  });

  it('rejects a malformed issuer rather than silently disabling login', () => {
    expect(() =>
      oidcSettingsFromEnv({ VITE_OIDC_ISSUER: 'not-a-url', VITE_OIDC_CLIENT_ID: 'web' }, ORIGIN),
    ).toThrow(/absolute URL/);
  });
});

// ---------------------------------------------------------------------------
// Real library: code+PKCE signin request + in-memory token store
// ---------------------------------------------------------------------------

describe('createUserManager — real authorization-code + PKCE request', () => {
  let server: Server;
  let issuer = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    issuer = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('builds an S256 PKCE authorize URL with state/nonce and no client secret', async () => {
    const manager = createUserManager({ ...SETTINGS, issuer, audience: 'https://api.disfap.test' });
    // The manager's settings are what the code+PKCE flow uses; drive the real
    // authorize-request builder with exactly those settings.
    expect(manager.settings.response_type).toBe('code');
    expect(manager.settings.extraQueryParams).toEqual({ audience: 'https://api.disfap.test' });
    const client = new OidcClient(manager.settings as unknown as OidcClientSettings);
    const request = await client.createSigninRequest({
      extraQueryParams: manager.settings.extraQueryParams,
      nonce: 'test-nonce-1',
    });
    const url = new URL(request.url);

    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('disfap-web');
    expect(url.searchParams.get('redirect_uri')).toBe(SETTINGS.redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBe('test-nonce-1');
    expect(url.searchParams.get('audience')).toBe('https://api.disfap.test');
    // A public client must never carry a secret.
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(request.url).not.toMatch(/client_secret/);
  });

  it('keeps user/token data in memory, never in localStorage', async () => {
    const manager = createUserManager({ ...SETTINGS, issuer });
    const store = manager.settings.userStore;
    const secret = JSON.stringify({ access_token: 'should-not-persist' });
    await store.set('probe', secret);
    // Nothing token-shaped was written to localStorage anywhere.
    const dumped = JSON.stringify(Object.entries(window.localStorage));
    expect(dumped).not.toContain('should-not-persist');
    // ...but the in-memory store still holds it for this page session.
    expect(await store.get('probe')).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// OidcAuth wrapper behaviour (injected fakes)
// ---------------------------------------------------------------------------

interface FakeState {
  user: OidcUserLike | null;
  callback: OidcUserLike | Error;
  silent: OidcUserLike | Error | null;
  signinState: string | undefined;
  signinNonce: string | undefined;
  removed: number;
  signoutArgs: { post_logout_redirect_uri?: string } | undefined;
}

function makeManager(state: FakeState): UserManagerLike {
  return {
    getUser: async () => state.user,
    signinRedirect: async (args) => {
      state.signinState = args?.state;
      state.signinNonce = args?.nonce;
    },
    signinRedirectCallback: async () => {
      if (state.callback instanceof Error) throw state.callback;
      return state.callback;
    },
    signinSilent: async () => {
      if (state.silent instanceof Error) throw state.silent;
      return state.silent;
    },
    signoutRedirect: async (args) => {
      state.signoutArgs = args;
    },
    removeUser: async () => {
      state.removed += 1;
    },
  };
}

interface FakeBrowser extends BrowserLike {
  last?: string;
}

function makeBrowser(over: Partial<BrowserLike> = {}): FakeBrowser {
  const b: FakeBrowser = {
    pathname: '/',
    search: '',
    hash: '#/',
    replace(url: string) {
      b.last = url;
    },
    ...over,
  };
  return b;
}

function baseState(over: Partial<FakeState> = {}): FakeState {
  return {
    user: null,
    callback: new Error('unused'),
    silent: null,
    signinState: undefined,
    signinNonce: undefined,
    removed: 0,
    signoutArgs: undefined,
    ...over,
  };
}

const LIVE_USER: OidcUserLike = {
  access_token: 'access-token-1',
  expires_at: Math.floor(Date.now() / 1000) + 300,
};

describe('OidcAuth — callback processing', () => {
  it('detects the callback request only on the redirect path with OAuth params', () => {
    const settings = SETTINGS;
    const onCallback = new OidcAuth(settings, makeManager(baseState()), {
      browser: makeBrowser({ pathname: '/auth/callback', search: '?code=x&state=y' }),
    });
    expect(onCallback.isCallbackRequest()).toBe(true);

    const elsewhere = new OidcAuth(settings, makeManager(baseState()), {
      browser: makeBrowser({ pathname: '/', search: '' }),
    });
    expect(elsewhere.isCallbackRequest()).toBe(false);
  });

  it('processes a successful callback, strips the query, and becomes authenticated', async () => {
    const state = baseState({ callback: LIVE_USER });
    const browser = makeBrowser({ pathname: '/auth/callback', search: '?code=abc&state=%23%2Fworkspaces' });
    const auth = new OidcAuth(SETTINGS, makeManager(state), { browser });

    await auth.init();

    expect(auth.error()).toBeNull();
    expect(auth.isAuthenticated()).toBe(true);
    expect(browser.last).toBe('/#/workspaces');
  });

  it('surfaces a denied login and stays unauthenticated', async () => {
    const state = baseState({ callback: new Error('interaction_required') });
    const browser = makeBrowser({
      pathname: '/auth/callback',
      search: '?error=access_denied&state=%23%2F',
    });
    const auth = new OidcAuth(SETTINGS, makeManager(state), { browser });

    await auth.init();

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.error()).toMatch(/denied/);
    expect(browser.last).toBe('/#/');
  });

  it('surfaces a callback error without an error param (e.g. invalid state)', async () => {
    const browser = makeBrowser({ pathname: '/auth/callback', search: '?code=abc&state=nope' });
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ callback: new Error('No matching state found') })), {
      browser,
    });

    await auth.init();

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.error()).toMatch(/No matching state found/);
  });
});

describe('OidcAuth — tokens, expiry and renewal', () => {
  it('returns the access token for a live session', async () => {
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: LIVE_USER })));
    expect(await auth.getAccessToken()).toBe('access-token-1');
  });

  it('returns null when there is no session', async () => {
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: null })));
    expect(await auth.getAccessToken()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('renews an expired token exactly once via silent renewal', async () => {
    const expired: OidcUserLike = { access_token: 'old', expires_at: Math.floor(Date.now() / 1000) - 10 };
    const renewed: OidcUserLike = { access_token: 'new', expires_at: Math.floor(Date.now() / 1000) + 300 };
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: expired, silent: renewed })));
    expect(await auth.getAccessToken()).toBe('new');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('drops state and returns null when renewal fails (no misleading auth)', async () => {
    const expired: OidcUserLike = { access_token: 'old', expires_at: Math.floor(Date.now() / 1000) - 10 };
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: expired, silent: new Error('no refresh') })));
    expect(await auth.getAccessToken()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });
});

describe('OidcAuth — login initiation & logout', () => {
  it('sanitizes the return target and supplies a nonce', async () => {
    const state = baseState();
    const auth = new OidcAuth(SETTINGS, makeManager(state));

    await auth.signin('https://evil.test/steal');
    expect(state.signinState).toBe('#/');
    expect(state.signinNonce).toBeTruthy();
  });

  it('preserves an in-app return route', async () => {
    const state = baseState();
    const auth = new OidcAuth(SETTINGS, makeManager(state));

    await auth.signin('#/workspaces');
    expect(state.signinState).toBe('#/workspaces');
  });

  it('clears the local session on sign-out (and asks the provider when configured)', async () => {
    const state = baseState({ user: LIVE_USER });
    const auth = new OidcAuth({ ...SETTINGS, postLogoutRedirectUri: `${ORIGIN}/` }, makeManager(state));
    await auth.getAccessToken(); // hydrate

    await auth.signout();

    expect(state.removed).toBe(1);
    expect(auth.isAuthenticated()).toBe(false);
    expect(state.signoutArgs?.post_logout_redirect_uri).toBe(`${ORIGIN}/`);
  });
});

// ---------------------------------------------------------------------------
// Boundary: the API client attaches the OIDC access token
// ---------------------------------------------------------------------------

function fakeFetch(): { calls: Array<[string, RequestInit]>; impl: typeof fetch } {
  const calls: Array<[string, RequestInit]> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    return { ok: true, status: 200, text: async () => '[]' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function authHeader(init: RequestInit): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  return key ? headers[key] : undefined;
}

describe('ApiClient + OidcAuth — access-token attachment', () => {
  it('attaches the access token from the OIDC session as a bearer header', async () => {
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: LIVE_USER })));
    const { calls, impl } = fakeFetch();
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl, getAccessToken: () => auth.getAccessToken() });

    await client.listLicenses();

    expect(authHeader(calls[0]![1])).toBe('Bearer access-token-1');
    expect(authHeader(calls[0]![1])).not.toMatch(/role/i);
  });

  it('sends no bearer header when the session is not authenticated', async () => {
    const auth = new OidcAuth(SETTINGS, makeManager(baseState({ user: null })));
    const { calls, impl } = fakeFetch();
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl, getAccessToken: () => auth.getAccessToken() });

    await client.listLicenses();

    expect(authHeader(calls[0]![1])).toBeUndefined();
  });
});
