/**
 * A minimal, self-contained OIDC provider for tests.
 *
 * It is NOT a general IdP — it implements just enough of the Authorization Code
 * + PKCE flow to exercise the real boundary: discovery, JWKS, `/authorize`
 * (with S256 challenge validation), and `/token` (which mints a genuine RS256
 * access token with the correct `iss`/`aud`/`sub`/`token_use`). Keys are
 * generated in-process; no real credentials or network services are involved.
 *
 * Test-only conveniences: `sub` may be supplied on `/authorize` to mint a token
 * for an arbitrary (possibly unmapped) subject.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

export interface OidcTestProviderOptions {
  /** Audience the minted access token is addressed to. */
  audience: string;
  /** Default subject for minted tokens. */
  subject: string;
  /** Access-token lifetime in seconds (default 300). */
  tokenTtlS?: number;
}

interface AuthorizationCode {
  subject: string;
  codeChallenge: string;
  redirectUri: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 S256 challenge for a given verifier. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export class OidcTestProvider {
  private server?: Server;
  private privateKey?: CryptoKey;
  private jwk?: JWK;
  private base = '';
  private readonly codes = new Map<string, AuthorizationCode>();

  constructor(private readonly opts: OidcTestProviderOptions) {}

  get issuer(): string {
    return this.base;
  }
  get jwksUrl(): string {
    return `${this.base}/jwks`;
  }
  get discoveryUrl(): string {
    return `${this.base}/.well-known/openid-configuration`;
  }

  async start(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'e2e-key-1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        json(res, 500, { error: 'server_error' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('test provider: no listen address');
    this.base = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json(res, 200, {
          issuer: this.base,
          jwks_uri: this.jwksUrl,
          authorization_endpoint: `${this.base}/authorize`,
          token_endpoint: `${this.base}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      case '/jwks':
        return json(res, 200, { keys: [this.jwk] });
      case '/authorize':
        return this.authorize(url, res);
      case '/token':
        return this.token(req, res);
      default:
        return json(res, 404, { error: 'not_found' });
    }
  }

  private authorize(url: URL, res: ServerResponse): void {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    const method = url.searchParams.get('code_challenge_method') ?? '';
    if (!redirectUri || url.searchParams.get('response_type') !== 'code' || method !== 'S256' || !challenge) {
      json(res, 400, { error: 'invalid_request' });
      return;
    }
    const code = randomUUID();
    this.codes.set(code, {
      subject: url.searchParams.get('sub') ?? this.opts.subject,
      codeChallenge: challenge,
      redirectUri,
    });
    const location = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state)}`;
    res.writeHead(302, { location });
    res.end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(req));
    if (body.get('grant_type') !== 'authorization_code') {
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const code = body.get('code') ?? '';
    const record = this.codes.get(code);
    if (!record) return json(res, 400, { error: 'invalid_grant' });

    const verifier = body.get('code_verifier') ?? '';
    if (record.codeChallenge !== pkceChallenge(verifier)) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    if ((body.get('redirect_uri') ?? '') !== record.redirectUri) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    this.codes.delete(code); // single-use

    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ token_use: 'access', scope: 'openid profile email' })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e-key-1', typ: 'at+jwt' })
      .setIssuer(this.base)
      .setAudience(this.opts.audience)
      .setSubject(record.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + (this.opts.tokenTtlS ?? 300))
      .sign(this.privateKey!);

    return json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.opts.tokenTtlS ?? 300,
      scope: 'openid profile email',
    });
  }
}

/**
 * Drive the full Authorization Code + PKCE flow against a provider and return
 * the access token — the same steps the browser client performs.
 */
export async function obtainAccessToken(
  provider: OidcTestProvider,
  opts: { clientId: string; redirectUri: string; subject?: string; codeVerifier?: string },
): Promise<{ accessToken: string; state: string }> {
  const codeVerifier = opts.codeVerifier ?? base64url(randomBytes(48));
  const state = randomUUID();
  const authorize = new URL(`${provider.issuer}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', opts.clientId);
  authorize.searchParams.set('redirect_uri', opts.redirectUri);
  authorize.searchParams.set('scope', 'openid profile email');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  if (opts.subject) authorize.searchParams.set('sub', opts.subject);

  const authRes = await fetch(authorize, { redirect: 'manual' });
  const location = authRes.headers.get('location');
  if (!location) throw new Error(`authorize did not redirect (status ${authRes.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('authorize redirect carried no code');

  const tokenRes = await fetch(`${provider.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: codeVerifier,
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new Error(`token exchange failed: ${tokenBody.error ?? tokenRes.status}`);
  }
  return { accessToken: tokenBody.access_token, state };
}
