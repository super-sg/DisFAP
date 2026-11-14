/// <reference types="vite/client" />

// Typed access to the build-time configuration the client relies on. The
// control-plane origin and the OIDC provider settings are configurable; the
// broker URL always arrives at runtime inside the (opaque) session response,
// never baked into the bundle.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;

  /** OIDC provider (issuer/discovery URL). Unset disables frontend login (dev). */
  readonly VITE_OIDC_ISSUER?: string;
  /** Public OIDC client id — there is no client secret in a browser client. */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Space-delimited scopes. Default: "openid profile email". */
  readonly VITE_OIDC_SCOPE?: string;
  /** API/resource audience the access token must be addressed to. */
  readonly VITE_OIDC_AUDIENCE?: string;
  /** Query parameter carrying the audience. Default: "audience". */
  readonly VITE_OIDC_AUDIENCE_PARAM?: string;
  /** Redirect path registered with the provider. Default: "/auth/callback". */
  readonly VITE_OIDC_REDIRECT_PATH?: string;
  /** RP-initiated logout return URL (absolute or origin-relative). */
  readonly VITE_OIDC_POST_LOGOUT_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
