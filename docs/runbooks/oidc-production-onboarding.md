# Runbook — connecting a real OIDC provider (production authentication)

> **Status: production authentication is NOT operational yet.** The control plane
> can verify OIDC access tokens and map them to internal users, and the browser
> now performs Authorization Code + PKCE login. What is missing is a **real
> provider**: everything below has been exercised only against local test
> issuers/fixtures. Do not claim production login works until every step here has
> been run against your provider and verified.
>
> This is provider-neutral. Any standards-compliant OIDC provider (Auth0, Okta,
> Entra ID, Keycloak, Cognito, Google Workspace, …) works, provided it supports
> the Authorization Code flow with PKCE and issues **JWT access tokens** for a
> custom API audience.

---

## 0. What you need before starting

| Thing | Where it goes | Notes |
|---|---|---|
| Issuer / discovery URL | `DFAP_OIDC_ISSUER` (api) · `VITE_OIDC_ISSUER` (web) | Must match the token `iss` **exactly**, including any trailing slash. |
| API resource identifier ("audience") | `DFAP_OIDC_AUDIENCE` (api) · `VITE_OIDC_AUDIENCE` (web) | The access-token audience. **Never** the SPA client id — that is an ID token. |
| Public client id | `VITE_OIDC_CLIENT_ID` (web) | Browser client. **No client secret exists** — this is a public client. |
| Redirect URI | registered at the provider | Default `${web origin}/auth/callback` (`VITE_OIDC_REDIRECT_PATH`). |
| Post-logout redirect URI (optional) | registered at the provider | `VITE_OIDC_POST_LOGOUT_REDIRECT_URI`. |
| A DB connection to the control-plane database | `DATABASE_URL` | Only to seed `external_identities` (below). |

---

## 1. Provider configuration

1. Create a **single-page / public** OIDC application (no client secret).
2. Set the **allowed redirect URI** to `${WEB_ORIGIN}${VITE_OIDC_REDIRECT_PATH}`
   (default `${WEB_ORIGIN}/auth/callback`). It must match character-for-character.
3. Enable the **Authorization Code** grant with **PKCE (S256)**. Do not enable
   the implicit flow.
4. Register an **API / resource server** whose identifier equals
   `DFAP_OIDC_AUDIENCE`, and make sure access tokens are **JWT** (not opaque) and
   carry that `aud`.
5. (Recommended) Have the provider mark access tokens so ID tokens can be told
   apart — either a `token_use: "access"` claim or an RFC 9068 `typ: at+jwt`
   JOSE header — and configure the matching `DFAP_OIDC_*` discriminator (below).

## 2. Control-plane configuration (`services/api` / `deploy/.env`)

```sh
DFAP_AUTH_MODE=oidc
DFAP_OIDC_ISSUER=https://login.example.com/     # exact iss
DFAP_OIDC_AUDIENCE=https://api.example.com       # the API's resource id
DFAP_CORS_ALLOWED_ORIGINS=https://app.example.com

# Optional, recommended:
DFAP_OIDC_JWKS_URL=                 # else discovered from the issuer
DFAP_OIDC_ALGORITHMS=RS256          # never `none`
DFAP_OIDC_ACCESS_TOKEN_TYP=at+jwt   # if the provider sets an RFC 9068 typ
DFAP_OIDC_TOKEN_USE_CLAIM=token_use # default
DFAP_OIDC_TOKEN_USE_VALUE=access    # default
DFAP_OIDC_REQUIRE_TOKEN_USE=true    # fail closed if the claim is absent
DFAP_OIDC_ORG_CLAIM=                # org *selector* only (validated against org_members)
```

`DFAP_AUTH_MODE=oidc` **fails to boot** without `DFAP_OIDC_ISSUER` and
`DFAP_OIDC_AUDIENCE`. Keys are fetched only from a server-configured JWKS
(explicit `DFAP_OIDC_JWKS_URL` or discovery); a request can never supply one.

## 3. Browser configuration (`apps/web`, build-time)

Vite bakes these in at build time; rebuild the web image after changing them.

```sh
VITE_OIDC_ISSUER=https://login.example.com/
VITE_OIDC_CLIENT_ID=<public client id>
VITE_OIDC_AUDIENCE=https://api.example.com
VITE_OIDC_AUDIENCE_PARAM=audience      # provider-specific query param for the audience
VITE_OIDC_SCOPE=openid profile email
VITE_OIDC_REDIRECT_PATH=/auth/callback
# VITE_OIDC_POST_LOGOUT_REDIRECT_URI=https://app.example.com/
```

Tokens are held **in memory** (never `localStorage`); the in-flight
state/nonce/PKCE verifier is kept in `sessionStorage` only for the redirect
round-trip. Consequence: a full page reload loses the session and the user must
sign in again. If you cannot accept that, that is a deliberate trade-off to
revisit with a silent-renew page — never by persisting tokens to disk.

## 4. Provision identity mappings (operator)

Every external identity must be mapped to an **existing** internal user first.
There is no just-in-time provisioning and email is never an identity key.

```sh
cd services/api
npm run build                       # produces dist/cli/provision-identity.js

DATABASE_URL='postgresql://…' node dist/cli/provision-identity.js \
  --issuer https://login.example.com/ \
  --subject '<the token sub for this person>' \
  --user '<internal DisFAP user id>' \
  [--email alice@example.com]
```

- Idempotent: re-running the same mapping prints `unchanged`.
- Refuses to repoint an existing `(issuer, subject)` to a different user unless
  you pass `--reassign` deliberately.
- Validates the internal user exists (`no such DisFAP user` otherwise).
- Prints only the action and non-secret identifiers — never tokens or secrets.

Find a user's `sub` from the provider's admin console, or from the `sub` claim of
a test token (do **not** paste real tokens into chat/logs).

## 5. Verify end to end (required)

1. Apply the migrations first (see §6).
2. Load the web app; you should be redirected to the provider.
3. Complete login; you land back on the requested page.
4. Open devtools → Network: the `/api/…` requests carry
   `Authorization: Bearer <JWT>`, and there is no role header.
5. Sign out; the app returns to the sign-in gate and further API calls are 401.
6. Negative checks: an **unmapped** user is refused (403); editing the token in
   devtools is refused (401); adding `x-dfap-role: admin` changes nothing.

## 6. Database

Migrations (`20261016000000_init`, `20261016010000_external_identities`) are
validated on a disposable cluster but **unapplied to any real database**:

```sh
cd services/api && npx prisma migrate deploy   # or: npx prisma migrate dev (local)
```

`external_identities` is keyed `UNIQUE (issuer, subject)` with a `user_id` FK
(`ON DELETE CASCADE`).

## 7. Rollback / kill switch

Set `DFAP_AUTH_MODE=deny` and restart: the API then rejects **every** request
(fail closed) rather than degrading to an unauthenticated mode. Clearing
`VITE_OIDC_*` and rebuilding the web app disables the browser login flow.
