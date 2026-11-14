import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, SessionInfo, WorkspaceTemplate } from '../src/api/client.js';
import { SessionView } from '../src/session/SessionView.js';
import type { LaunchResult } from '../src/session/launch-types.js';

/**
 * Browser reconnection (Objective E).
 *
 * The controller must:
 *  - fetch a FRESH single-use handle before every retry (never reuse the old
 *    one — its jti and wrap token are spent);
 *  - treat `disconnected` as connectable while the server's grace window is
 *    open, and `ended`/`failed`/`terminating` as terminal;
 *  - stop cleanly after the bounded budget;
 *  - never write credential material (or the handle) to browser storage.
 *
 * GuacsessionView is replaced by a controllable stub so these tests own the
 * tunnel lifecycle rather than guacamole-common-js.
 */

const observed = vi.hoisted(() => ({ mounts: 0, props: [] as Record<string, unknown>[] }));

vi.mock('../src/session/GuacsessionView.js', async () => {
  const React = await import('react');
  const h = React.createElement;
  return {
    GuacsessionView: (props: {
      token: string;
      brokerUrl: string;
      onChannelOpen: () => void;
      onConnected: () => void;
      onClose: (transient: boolean) => void;
      onError: (reason: string) => void;
    }) => {
      observed.mounts += 1;
      observed.props.push({ ...props });
      return h(
        'div',
        { 'data-testid': 'guac', 'data-token': props.token },
        h('button', { 'data-testid': 'open', onClick: props.onChannelOpen }),
        h('button', { 'data-testid': 'first-frame', onClick: props.onConnected }),
        h('button', { 'data-testid': 'drop', onClick: () => props.onClose(true) }),
        h('button', { 'data-testid': 'intentional-close', onClick: () => props.onClose(false) }),
        h('button', { 'data-testid': 'error', onClick: () => props.onError('tunnel error') }),
      );
    },
  };
});

const TEMPLATE: WorkspaceTemplate = {
  id: 'tpl_1',
  name: 'DevBox',
  description: 'test',
  os: 'linux',
  recording: false,
};

function connect(token: string) {
  return { token, brokerUrl: 'wss://broker.test/tunnel', expiresAt: '2030-01-01T00:00:00Z' };
}

function initial(): LaunchResult {
  return {
    session: {
      id: 'ses_1',
      templateId: 'tpl_1',
      state: 'ready',
      recording: false,
      connect: connect('DFAP1.old.sig'),
      disconnectDeadlineAt: null,
    },
    template: TEMPLATE,
    connect: connect('DFAP1.old.sig'),
  };
}

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'ses_1',
    templateId: 'tpl_1',
    state: 'disconnected',
    recording: false,
    disconnectDeadlineAt: '2030-01-01T00:00:30Z',
    ...overrides,
  };
}

interface FakeApi {
  getSession: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
}

function api(sequence: Array<SessionInfo | Error>): FakeApi {
  let n = 0;
  const getSession = vi.fn(async () => {
    const next = sequence[Math.min(n, sequence.length - 1)];
    n += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  return { getSession, endSession: vi.fn(async () => undefined) };
}

function renderView(client: FakeApi, launch = initial()) {
  return render(<SessionView api={client as unknown as ApiClient} initial={launch} onExit={() => undefined} />);
}

/** Advance fake timers and flush the async effects they kick off. */
async function advance(ms = 10_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function goLive() {
  fireEvent.click(screen.getByTestId('open'));
  fireEvent.click(screen.getByTestId('first-frame'));
}

beforeEach(() => {
  vi.useFakeTimers();
  observed.mounts = 0;
  observed.props.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('reconnect fetches a fresh handle', () => {
  it('re-fetches on a transient drop and remounts with the new capability', async () => {
    const client = api([
      info({ state: 'disconnected', connect: connect('DFAP1.fresh.sig') }),
    ]);
    renderView(client);
    goLive();
    expect(screen.getByTestId('guac').getAttribute('data-token')).toBe('DFAP1.old.sig');

    fireEvent.click(screen.getByTestId('drop'));
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    expect(client.getSession).not.toHaveBeenCalled(); // backoff first

    await advance();

    expect(client.getSession).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledWith('ses_1');
    // The single-use handle was replaced, not reused.
    expect(screen.getByTestId('guac').getAttribute('data-token')).toBe('DFAP1.fresh.sig');

    goLive();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });

  it('counts one lifecycle event per attempt (error + close from the same drop)', async () => {
    const client = api([info({ state: 'disconnected', connect: connect('DFAP1.fresh.sig') })]);
    renderView(client);
    goLive();

    // The socket layer may report the error AND then the close; only one retry.
    fireEvent.click(screen.getByTestId('error'));
    fireEvent.click(screen.getByTestId('drop'));
    await advance();

    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale intentional close from the replaced socket', async () => {
    const client = api([info({ state: 'disconnected', connect: connect('DFAP1.fresh.sig') })]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('drop'));
    await advance();
    // The old GuacsessionView's cleanup can report its disconnect after the
    // remount. It must not knock the fresh attempt out of `connecting`.
    fireEvent.click(screen.getByTestId('intentional-close'));
    expect(screen.queryByText(/Reconnecting/)).toBeNull();

    goLive();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    await advance();
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after an intentional close', async () => {
    const client = api([info({ connect: connect('DFAP1.fresh.sig') })]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('intentional-close'));
    await advance();

    expect(client.getSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('guac').getAttribute('data-token')).toBe('DFAP1.old.sig');
  });
});

describe('server-terminal states', () => {
  it('latches to expired when the server says the session ended', async () => {
    const client = api([info({ state: 'ended', endReason: 'idle_timeout' })]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('drop'));
    await advance();

    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByText('This session has ended.')).toBeTruthy();
    // Terminal: the retry loop stops even with time left on the clock.
    await advance(60_000);
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it('treats a disconnected row with no handle as grace-expired (terminal)', async () => {
    const client = api([info({ state: 'disconnected' })]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('drop'));
    await advance();

    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByText('The reconnect window has expired.')).toBeTruthy();
    await advance(60_000);
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it('treats a failed row as terminal', async () => {
    const client = api([info({ state: 'failed' })]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('drop'));
    await advance();

    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByText(/no longer available/)).toBeTruthy();
  });
});

describe('bounded retry and storage hygiene', () => {
  it('surfaces an error after the bounded budget instead of looping forever', async () => {
    const client = api([new Error('control plane down')]);
    renderView(client);
    goLive();

    fireEvent.click(screen.getByTestId('drop'));
    for (let i = 0; i < 5; i++) await advance();

    expect(client.getSession).toHaveBeenCalledTimes(5);
    expect(screen.getByText('Session disconnected')).toBeTruthy();
    expect(screen.getByText('control plane down')).toBeTruthy();

    await advance(60_000);
    expect(client.getSession).toHaveBeenCalledTimes(5);
  });

  it('never writes a handle or credential to browser storage', async () => {
    const client = api([
      info({
        state: 'disconnected',
        connect: attachSecretProbe(connect('DFAP1.fresh.sig')),
      }),
    ]);
    renderView(client);
    goLive();
    fireEvent.click(screen.getByTestId('drop'));
    await advance();
    goLive();

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    const tokens = observed.props.map((p) => p['token']);
    expect(tokens).toContain('DFAP1.old.sig');
    expect(tokens).toContain('DFAP1.fresh.sig');
    // The only fields handed to the tunnel are broker URL + opaque token.
    for (const p of observed.props) {
      const keys = Object.keys(p).sort();
      expect(keys).toEqual(['brokerUrl', 'onChannelOpen', 'onClose', 'onConnected', 'onError', 'token']);
    }
  });

  it('ends the session and exits on the End session button', async () => {
    const onExit = vi.fn();
    const client = api([]);
    render(
      <SessionView
        api={client as unknown as ApiClient}
        initial={initial()}
        onExit={onExit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(client.endSession).toHaveBeenCalledWith('ses_1');
    expect(onExit).toHaveBeenCalledTimes(1);
    await advance();
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('waits for the end response before exiting and reports failures', async () => {
    const onExit = vi.fn();
    const client = api([]);
    let resolveEnd!: () => void;
    client.endSession = vi.fn(() => new Promise<void>((resolve) => { resolveEnd = resolve; }));
    render(<SessionView api={client as unknown as ApiClient} initial={initial()} onExit={onExit} />);

    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect((screen.getByRole('button', { name: 'Ending…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    await act(async () => resolveEnd());
    expect(onExit).toHaveBeenCalledTimes(1);

    const failedExit = vi.fn();
    const failedClient = api([]);
    failedClient.endSession = vi.fn(async () => { throw new Error('teardown unavailable'); });
    render(<SessionView api={failedClient as unknown as ApiClient} initial={initial()} onExit={failedExit} />);
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('alert').textContent).toContain('teardown unavailable');
    expect(failedExit).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'End session' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * Extra keys a buggy payload might smuggle in. The component must ignore them;
 * this helper only makes the risk explicit in the fixture.
 */
function attachSecretProbe(base: { token: string; brokerUrl: string; expiresAt: string }) {
  return { ...base, username: 'dfap-user', password: 'S3cret-PW', host: '10.0.0.5' } as typeof base;
}
