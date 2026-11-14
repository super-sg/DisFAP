import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ApiClient, type SessionInfo, type WorkspaceTemplate, type ServerSessionState } from '../src/api/client.js';
import { useSessionLaunch } from '../src/session/useSessionLaunch.js';

/**
 * The launch state machine, extracted from `LaunchPage` in the r10 split.
 *
 * These assertions are the behaviour that page used to own inline: the server
 * decides when a session is ready, a transient control-plane failure must not
 * kill a long cold start, and a hard 4xx must. The connect handle handed up
 * must be the freshest one the last poll returned.
 */

const TEMPLATE: WorkspaceTemplate = {
  id: 'tmpl_1',
  name: 'DevBox',
  description: 'test',
  os: 'linux',
  recording: false,
};

function sessionInfo(state: ServerSessionState, endReason?: string): SessionInfo {
  return {
    id: 'ses_1',
    templateId: 'tmpl_1',
    state,
    recording: false,
    ...(endReason !== undefined ? { endReason } : {}),
    ...(state === 'ready'
      ? { connect: { token: 'DFAP1.tok', brokerUrl: 'ws://localhost:8080', expiresAt: '2030-01-01T00:00:00Z' } }
      : {}),
  };
}

/** An ApiClient stand-in exposing only what the hook calls. */
function fakeApi(getSession: () => Promise<SessionInfo>) {
  return {
    startSession: vi.fn(async () => ({
      sessionId: 'ses_1',
      token: 'DFAP1.start',
      brokerUrl: 'ws://localhost:8080',
      expiresAt: '2030-01-01T00:00:00Z',
    })),
    rentLicense: vi.fn(),
    getSession: vi.fn(getSession),
  } as unknown as ApiClient;
}

/** Let the immediate `poll()` and its awaits settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_500);
  });
}

describe('useSessionLaunch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls until the server reports ready, then hands up the freshest handle', async () => {
    vi.useFakeTimers();
    const queue: ServerSessionState[] = ['requested', 'allocating', 'ready'];
    const api = fakeApi(async () => sessionInfo(queue.shift() ?? 'ready'));
    const onReady = vi.fn();

    const { result } = renderHook(() => useSessionLaunch(api, onReady));

    await act(async () => {
      await result.current.startWorkspace(TEMPLATE);
    });
    expect(result.current.launching).toMatchObject({ sessionId: 'ses_1', template: TEMPLATE });

    await flush(); // poll #1 → requested
    expect(result.current.serverState).toBe('requested');
    expect(onReady).not.toHaveBeenCalled();

    await tick(); // poll #2 → allocating
    expect(result.current.serverState).toBe('allocating');

    await tick(); // poll #3 → ready
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]![0]).toMatchObject({
      template: TEMPLATE,
      connect: { token: 'DFAP1.tok', brokerUrl: 'ws://localhost:8080' },
      session: { id: 'ses_1', state: 'ready' },
    });
  });

  it('stops with the server reason when the session dies before it is ready', async () => {
    vi.useFakeTimers();
    const api = fakeApi(async () => sessionInfo('failed', 'spot_interruption'));
    const onReady = vi.fn();

    const { result } = renderHook(() => useSessionLaunch(api, onReady));
    await act(async () => {
      await result.current.startWorkspace(TEMPLATE);
    });
    await flush();

    expect(onReady).not.toHaveBeenCalled();
    expect(result.current.launching).toBeNull();
    expect(result.current.startError).toBe('spot_interruption');
  });

  it('treats a hard 4xx as fatal (the session is gone, not slow)', async () => {
    vi.useFakeTimers();
    const api = fakeApi(async () => {
      throw new ApiError(404, 'session not found');
    });
    const onReady = vi.fn();

    const { result } = renderHook(() => useSessionLaunch(api, onReady));
    await act(async () => {
      await result.current.startWorkspace(TEMPLATE);
    });
    await flush();

    expect(result.current.launching).toBeNull();
    expect(result.current.startError).toBe('session not found');
    expect(onReady).not.toHaveBeenCalled();
  });

  it('keeps polling through a transient 5xx (a long cold start is not a failure)', async () => {
    vi.useFakeTimers();
    let call = 0;
    const api = fakeApi(async () => {
      call += 1;
      if (call === 1) throw new ApiError(503, 'temporarily unavailable');
      return sessionInfo('ready');
    });
    const onReady = vi.fn();

    const { result } = renderHook(() => useSessionLaunch(api, onReady));
    await act(async () => {
      await result.current.startWorkspace(TEMPLATE);
    });
    await flush(); // throws 503, must not abort

    expect(result.current.startError).toBeNull();
    expect(result.current.launching).not.toBeNull();

    await tick(); // retry → ready
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('reports a failed rent without starting a launch', async () => {
    vi.useFakeTimers();
    const api = fakeApi(async () => sessionInfo('requested'));
    (api.rentLicense as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(400, 'hoursRequested must be an integer between 1 and 24'),
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useSessionLaunch(api, onReady));
    await act(async () => {
      await result.current.startRental(
        { id: 'lic_1', softwareName: 'Demo', version: '1.0', category: 'engineering', description: '', os: 'linux', hourlyRateUsd: 2, ownerName: 'o', status: 'available', hsmKeyFingerprint: 'fp' },
        2,
      );
    });

    expect(result.current.launching).toBeNull();
    expect(result.current.startError).toMatch(/hoursRequested/);
    expect(onReady).not.toHaveBeenCalled();
  });
});
