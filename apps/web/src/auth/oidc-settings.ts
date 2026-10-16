/**
 * Provider-neutral OIDC settings for the browser client.
 *
 * The client performs the OAuth 2.0 **Authorization Code flow with PKCE** and
 * never handles a client secret (there is none: this is a public client). It is
 * deliberately provider-neutral — any standards-compliant OIDC provider works by
 * pointing `VITE_OIDC_ISSUER` at it — so a real provider can be selected later
 * without code changes.
 *
 * Configuration is read from Vite build-time env (see vite-env.d.ts):
 *   VITE_OIDC_ISSUER                  issuer / discovery URL (required to enable)
 *   VITE_OIDC_CLIENT_ID               public client id (required to enable)
 *   VITE_OIDC_SCOPE                   default "openid profile email"
 *   VITE_OIDC_AUDIENCE                API/resource identifier to request
 *   VITE_OIDC_AUDIENCE_PARAM          query param carrying the audience (default "audience")
 *   VITE_OIDC_REDIRECT_PATH           default "/auth/callback"
 *   VITE_OIDC_POST_LOGOUT_REDIRECT_URI  optional RP-initiated logout return
 *
 * When issuer/clientId are unset the app runs WITHOUT frontend login (local dev
 * only). In that mode the API still fails closed unless it is itself in a dev
 * configuration, so an unauthenticated production build cannot silently act.
 */

import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  scope: string;
  /** API resource/audience the access token must be addressed to (optional). */
  audience?: string;
  /** Query parameter used to request `audience` (provider-specific, default). */
  audienceParam: string;
  /** Absolute redirect URI registered with the provider. */
  redirectUri: string;
  /** Absolute post-logout redirect URI, when RP-initiated logout is used. */
  postLogoutRedirectUri?: string;
}

export type EnvRecord = Record<string, string | undefined>;

class OidcConfigError extends Error {}

function absoluteUrl(origin: string, value: string): string {
  // Accept an absolute URL, or origin-relative path.
  if (/^https?:\/\//i.test(value)) return value;
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${origin.replace(/\/+$/, '')}${path}`;
}

/**
 * Build settings from env, or `null` when OIDC is not configured (local dev).
 * A configured-but-invalid issuer fails loudly rather than silently disabling
 * login (which would leave the UI in a misleadingly unauthenticated state).
 */
export function oidcSettingsFromEnv(env: EnvRecord, origin: string): OidcSettings | null {
  const issuer = env['VITE_OIDC_ISSUER']?.trim();
  const clientId = env['VITE_OIDC_CLIENT_ID']?.trim();
  if (!issuer && !clientId) return null;
  if (!issuer) throw new OidcConfigError('VITE_OIDC_CLIENT_ID is set but VITE_OIDC_ISSUER is missing');
  if (!clientId) throw new OidcConfigError('VITE_OIDC_ISSUER is set but VITE_OIDC_CLIENT_ID is missing');

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new OidcConfigError(`VITE_OIDC_ISSUER must be an absolute URL, got ${JSON.stringify(issuer)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OidcConfigError('VITE_OIDC_ISSUER must be an http(s) URL');
  }

  const audience = env['VITE_OIDC_AUDIENCE']?.trim();
  const postLogout = env['VITE_OIDC_POST_LOGOUT_REDIRECT_URI']?.trim();

  return {
    issuer,
    clientId,
    scope: env['VITE_OIDC_SCOPE']?.trim() || 'openid profile email',
    audienceParam: env['VITE_OIDC_AUDIENCE_PARAM']?.trim() || 'audience',
    redirectUri: absoluteUrl(origin, env['VITE_OIDC_REDIRECT_PATH']?.trim() || '/auth/callback'),
    ...(audience ? { audience } : {}),
    ...(postLogout ? { postLogoutRedirectUri: absoluteUrl(origin, postLogout) } : {}),
  };
}

/**
 * Construct the `oidc-client-ts` manager for the code+PKCE flow.
 *
 * Tokens are held in an **in-memory** store, never localStorage: a same-page
 * XSS cannot lift a persisted token and it survives no reload. The library still
 * persists the *in-flight* auth state (state/nonce/PKCE verifier) in
 * sessionStorage for the redirect round-trip — that is not token material and is
 * cleared by the library once the callback is processed.
 */
export function createUserManager(settings: OidcSettings): UserManager {
  return new UserManager({
    authority: settings.issuer,
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: settings.scope,
    // In-memory token storage (see note above).
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // We renew on demand (getAccessToken) rather than via an iframe, which would
    // require a served silent-renew page; automaticSilentRenew is left off so a
    // provider without refresh tokens/silent support cannot spin.
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    ...(settings.postLogoutRedirectUri
      ? { post_logout_redirect_uri: settings.postLogoutRedirectUri }
      : {}),
    ...(settings.audience
      ? { extraQueryParams: { [settings.audienceParam]: settings.audience } }
      : {}),
  });
}
