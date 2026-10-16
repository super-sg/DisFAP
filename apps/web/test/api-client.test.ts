import { describe, expect, it } from 'vitest';

import { ApiClient } from '../src/api/client.js';

function fakeFetch(): { calls: Array<[string, RequestInit]>; impl: typeof fetch } {
  const calls: Array<[string, RequestInit]> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function headerValue(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

describe('ApiClient — bearer token', () => {
  it('sends Authorization: Bearer when a getAccessToken provider is supplied', async () => {
    const { calls, impl } = fakeFetch();
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl, getAccessToken: () => 'tok-123' });

    await client.listLicenses();

    expect(calls).toHaveLength(1);
    expect(headerValue(calls[0]![1], 'authorization')).toBe('Bearer tok-123');
  });

  it('awaits an async token provider', async () => {
    const { calls, impl } = fakeFetch();
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: impl,
      getAccessToken: async () => 'tok-async',
    });

    await client.listLicenses();
    expect(headerValue(calls[0]![1], 'authorization')).toBe('Bearer tok-async');
  });

  it('omits Authorization when the provider yields null or is absent', async () => {
    const a = fakeFetch();
    await new ApiClient({ baseUrl: 'http://api.test', fetch: a.impl, getAccessToken: () => null }).listLicenses();
    expect(headerValue(a.calls[0]![1], 'authorization')).toBeUndefined();

    const b = fakeFetch();
    await new ApiClient({ baseUrl: 'http://api.test', fetch: b.impl }).listLicenses();
    expect(headerValue(b.calls[0]![1], 'authorization')).toBeUndefined();
  });

  it('never sends a role header', async () => {
    const { calls, impl } = fakeFetch();
    await new ApiClient({ baseUrl: 'http://api.test', fetch: impl, getAccessToken: () => 'tok' }).listLicenses();
    const headers = (calls[0]![1].headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'x-dfap-role')).toBe(false);
  });
});
