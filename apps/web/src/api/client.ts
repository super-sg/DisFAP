/**
 * Typed client for the DisFAP control plane (services/api).
 *
 * Design notes tied to the security model:
 *  - The only thing that ever reaches the browser to reach a session is an
 *    opaque DFAP1 handle (`token`) plus the broker URL. There is no hostname,
 *    username, or password in any response here — by construction (see
 *    docs/security.md, Guarantee 2). The types below reflect that.
 *  - Connect handles live ~60 s and are single-use. A session that outlives a
 *    handle (idle → reconnect, or the 90-150 s Phase-0 cold start) simply reads
 *    a *fresh* handle from `getSession`, which re-mints one when the session is
 *    connectable. Reconnect is therefore just "poll getSession again".
 */

/** Authoritative server-side session lifecycle (docs/architecture.md). */
export type ServerSessionState =
  | 'requested'
  | 'allocating'
  | 'ready'
  | 'connected'
  | 'idle'
  | 'disconnected'
  | 'terminating'
  | 'ended'
  | 'failed';

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description?: string;
  os: 'windows' | 'linux';
  /** Whether sessions from this template are recorded (WORM, see Guarantee 5). */
  recording: boolean;
}

/** Everything the browser needs to open the pixel tunnel — and nothing else. */
export interface ConnectCredentials {
  /** Opaque DFAP1 capability handle. Never carries connection params. */
  token: string;
  /** Broker WebSocket base, e.g. "wss://broker.disfap.example". */
  brokerUrl: string;
  /** ISO-8601 expiry of `token` (~60 s out). */
  expiresAt: string;
}

export interface StartSessionResponse extends ConnectCredentials {
  sessionId: string;
}

export interface MarketplaceLicense {
  id: string;
  softwareName: string;
  version: string;
  category: string;
  description: string;
  os: 'windows' | 'linux';
  hourlyRateUsd: number;
  ownerName: string;
  status: 'available' | 'rented' | 'paused';
  hsmKeyFingerprint: string;
}

/** What an owner submits to publish a listing (Layer 1 + Layer 2). */
export interface CreateLicenseRequest {
  softwareName: string;
  version?: string;
  category?: string;
  description?: string;
  os: 'windows' | 'linux';
  hourlyRateUsd?: number;
  /** Dedicated, non-personal demo credential for the licensed app. */
  credentials: { username: string; password?: string };
}

export interface CreatedLicense {
  id: string;
  softwareName: string;
  version: string;
  category: string;
  hourlyRateUsd: number;
  status: string;
  hsmKeyFingerprint: string;
}

export interface RentLicenseResponse extends StartSessionResponse {
  license: {
    id: string;
    softwareName: string;
    version: string;
    hourlyRateUsd: number;
    totalChargedUsd: number;
  };
  telemetry: {
    thread1VmSpoolingMs: number;
    thread2CredentialRetrievalMs: number;
    orchestratorTotalMs: number;
    hsmKeyFingerprint: string;
  };
}

export interface SessionInfo {
  id: string;
  templateId: string;
  state: ServerSessionState;
  recording: boolean;
  /**
   * Fresh connect credentials — present only while the session is connectable
   * (`ready` | `connected` | `idle`). Re-read on every poll; each read may
   * return a newly minted, single-use handle.
   */
  connect?: ConnectCredentials;
  /** Set once the first pixel has been observed server-side (the headline SLI). */
  firstPixelAt?: string | null;
  endReason?: string | null;
}

/** Thrown for any non-2xx control-plane response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when a session state can accept (or already holds) a pixel tunnel. */
export function isConnectable(state: ServerSessionState): boolean {
  return state === 'ready' || state === 'connected' || state === 'idle';
}

/** True when a session has reached a terminal, non-recoverable state. */
export function isTerminal(state: ServerSessionState): boolean {
  return state === 'terminating' || state === 'ended' || state === 'failed';
}

export interface ApiClientOptions {
  /** Control-plane origin. Defaults to VITE_API_BASE_URL, then same-origin "". */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /**
   * Supplies the OIDC access token for the `Authorization: Bearer` header.
   *
   * PRODUCTION LOGIN IS NOT WIRED YET: no OIDC authorization-code+PKCE flow is
   * implemented in this client, so there is no default implementation. The app
   * must pass a function that returns a currently-valid access token (and
   * refreshes it). Returning null sends no Authorization header, which the API
   * will reject in any non-dev configuration.
   */
  getAccessToken?: () => Promise<string | null> | string | null;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: (() => Promise<string | null> | string | null) | undefined;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
    // Bind so the injected/global fetch keeps its expected `this`.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.getAccessToken = opts.getAccessToken;
  }

  /** List the workspace templates the current user is entitled to launch. */
  async listTemplates(): Promise<WorkspaceTemplate[]> {
    return this.request<WorkspaceTemplate[]>('GET', '/api/templates');
  }

  /** Browse available software licenses from owners in the Layer 1 Marketplace. */
  async listLicenses(category?: string): Promise<MarketplaceLicense[]> {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    return this.request<MarketplaceLicense[]>('GET', `/api/marketplace/licenses${query}`);
  }

  /**
   * Publish a software listing (Layer 1). Credentials are encrypted server-side
   * by the Layer 2 HSM and never returned. The owner identity is taken from the
   * authenticated principal, never from this body.
   */
  async createLicense(input: CreateLicenseRequest): Promise<CreatedLicense> {
    return this.request<CreatedLicense>('POST', '/api/marketplace/licenses', input);
  }

  /** Rent software license, triggering Layer 3 Two-Thread Orchestration. */
  async rentLicense(licenseId: string, hoursRequested = 1): Promise<RentLicenseResponse> {
    return this.request<RentLicenseResponse>('POST', '/api/marketplace/rent', {
      licenseId,
      hoursRequested,
    });
  }

  /**
   * Begin a session for a template. The control plane claims a VM (or cold-
   * launches one in Phase-0) and returns the sessionId plus a first connect
   * handle. During a cold start the session may still be `allocating`; poll
   * `getSession` for progress and a fresh handle before connecting.
   */
  async startSession(templateId: string): Promise<StartSessionResponse> {
    return this.request<StartSessionResponse>('POST', '/api/sessions', { templateId });
  }

  /** Current state of a session, including fresh connect credentials if ready. */
  async getSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('GET', `/api/sessions/${encodeURIComponent(id)}`);
  }

  /** Request teardown of a session. Idempotent server-side. */
  async endSession(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const accessToken = this.getAccessToken ? await this.getAccessToken() : null;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      // Session-user auth is a bearer access token (OIDC). The cookie is only a
      // fallback for same-origin deployments that terminate auth at the edge.
      credentials: 'include',
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        // LOCAL DEV ONLY: the control plane's dev identity adapter reads these
        // headers and is refused outside development. Vite drops them from
        // production bundles. A role header is never sent — the server derives
        // privilege from server-side records, never from the client.
        ...(import.meta.env.DEV ? { 'x-dfap-user': 'usr_dev', 'x-dfap-org': 'org_dev' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const parsed = await safeReadBody(res);
      const message =
        typeof parsed === 'object' && parsed !== null && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : `${method} ${path} failed with ${res.status}`;
      throw new ApiError(res.status, message, parsed);
    }

    // 204 / empty bodies (e.g. DELETE) resolve to undefined.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function safeReadBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}
