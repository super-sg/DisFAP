/**
 * Trusted access-token verification, built on the maintained `jose` library.
 *
 * We never hand-roll crypto: `jose` performs signature verification, and
 * `createRemoteJWKSet` provides the caching + rotation behavior (it refetches
 * the JWKS when a token presents a `kid` it has not seen, subject to a cooldown).
 *
 * Hard rules encoded here:
 *  - the JWKS location comes ONLY from server configuration (an explicit URL or
 *    OIDC discovery); a request can never supply a key or a JWKS URL
 *  - the signing-algorithm allowlist is configurable and never includes `none`
 *  - `issuer`/`audience` are exact-matched; `exp`/`nbf` are checked
 *  - a `sub` claim is required
 *  - access tokens are distinguished from ID tokens via a configurable header
 *    `typ` and/or a `token_use`-style claim
 *  - any failure (bad signature, unknown key, malformed, expired, JWKS/
 *    discovery unreachable) is a 401 — never an unverified accept
 */

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

import { UnauthorizedError } from './authenticator.js';

export interface OidcVerifierConfig {
  /** Exact expected `iss` (canonical form, e.g. with or without trailing slash). */
  issuer: string;
  /** Exact expected audience (the API's resource identifier, NOT a client id). */
  audience: string;
  /** Explicit JWKS URL; when absent, discovery is used. */
  jwksUrl?: string;
  /** Permitted JWS algorithms (e.g. `RS256`); `none` is never permitted. */
  algorithms: string[];
  /** Allowed clock skew for `exp`/`nbf`, seconds. */
  clockToleranceS: number;
  /** Optional claim naming the organization (a selector, never a grant). */
  orgClaim?: string;
  /** Optional required JOSE header `typ` (e.g. `at+jwt`, RFC 9068). */
  accessTokenTyp?: string;
  /** Claim used to distinguish an access token from an ID token. */
  tokenUseClaim: string;
  /** Value the token-use claim must hold for an access token. */
  tokenUseValue: string;
  /** When true, the token-use claim MUST be present (not just consistent). */
  requireTokenUse: boolean;
  /** Max age (s) a fetched JWKS is trusted before refetch. */
  jwksCacheMaxAgeS: number;
  /** Min interval (s) between JWKS refetches after an unknown `kid`. */
  jwksCooldownS: number;
}

/** The subset of a verified token the rest of the system consumes. */
export interface VerifiedAccessToken {
  /** Canonical issuer (the configured value, which verification pinned). */
  issuer: string;
  /** The token's `sub`. */
  subject: string;
  claims: Record<string, unknown>;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedAccessToken>;
}

const JWKS_FETCH_TIMEOUT_MS = 5_000;

function unauthorized(message: string): UnauthorizedError {
  return new UnauthorizedError(message);
}

/**
 * jose-backed verifier. Constructing it performs NO network I/O: the JWKS is
 * fetched lazily on first verification and then cached (with rotation), and
 * discovery is resolved once and cached. This keeps boot and unit tests offline.
 */
export class JoseAccessTokenVerifier implements AccessTokenVerifier {
  private getKey: ReturnType<typeof createRemoteJWKSet> | undefined;
  private discovering: Promise<string> | undefined;

  constructor(private readonly config: OidcVerifierConfig) {}

  async verify(token: string): Promise<VerifiedAccessToken> {
    if (!token || token.split('.').length !== 3) throw unauthorized('malformed token');

    let typ: string | undefined;
    try {
      const header = decodeProtectedHeader(token);
      typ = typeof header.typ === 'string' ? header.typ : undefined;
    } catch {
      throw unauthorized('malformed token header');
    }
    if (this.config.accessTokenTyp !== undefined && typ !== this.config.accessTokenTyp) {
      throw unauthorized(`unexpected token type ${JSON.stringify(typ)}`);
    }

    const key = await this.keyResolver();

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, key, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceS,
        requiredClaims: ['sub'],
      });
      payload = result.payload;
    } catch (err) {
      // Signature / issuer / audience / exp / nbf / alg / unknown-key / JWKS
      // fetch failures all land here and all become a 401. The message carries
      // the jose error code only — never token contents.
      const code = (err as { code?: unknown }).code;
      throw unauthorized(`token verification failed${typeof code === 'string' ? ` (${code})` : ''}`);
    }

    // Access-token policy. When the claim is present it must be consistent; the
    // claim may be required outright for providers that always set it.
    const use = payload[this.config.tokenUseClaim];
    if (use !== undefined) {
      if (use !== this.config.tokenUseValue) throw unauthorized('not an access token');
    } else if (this.config.requireTokenUse) {
      throw unauthorized('missing token-use claim');
    }

    if (typeof payload.sub !== 'string' || payload.sub === '') throw unauthorized('missing subject');
    return { issuer: this.config.issuer, subject: payload.sub, claims: payload as Record<string, unknown> };
  }

  private async keyResolver(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.getKey) return this.getKey;
    const url = this.config.jwksUrl ?? (await this.jwksUrlFromDiscovery());
    this.getKey = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: this.config.jwksCacheMaxAgeS * 1000,
      cooldownDuration: this.config.jwksCooldownS * 1000,
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    });
    return this.getKey;
  }

  private jwksUrlFromDiscovery(): Promise<string> {
    if (!this.discovering) this.discovering = this.discover();
    return this.discovering;
  }

  private async discover(): Promise<string> {
    const wellKnown = `${this.config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await fetch(wellKnown, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    } catch {
      throw unauthorized('OIDC discovery unavailable');
    }
    if (!res.ok) throw unauthorized(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json().catch(() => null)) as { issuer?: unknown; jwks_uri?: unknown } | null;
    // Pin the discovered issuer to the configured one: a discovery document
    // that claims a different issuer is not a trust source we accept.
    if (!doc || doc.issuer !== this.config.issuer || typeof doc.jwks_uri !== 'string' || doc.jwks_uri === '') {
      throw unauthorized('OIDC discovery document is invalid or mismatched');
    }
    return doc.jwks_uri;
  }
}
