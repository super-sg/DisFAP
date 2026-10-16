import { describe, expect, it, vi } from 'vitest';

// Mock guacamole-common-js down to just the pieces DfapTunnel touches. This
// keeps the test hermetic (no real Guacamole, no real WebSocket).
vi.mock('guacamole-common-js', () => {
  class Parser {
    oninstruction: ((opcode: string, args: string[]) => void) | null = null;
    receive(): void {}
  }
  class Status {
    constructor(
      public code: number,
      public message?: string,
    ) {}
    isError(): boolean {
      return true;
    }
  }
  return {
    default: {
      Parser,
      Status,
      Tunnel: { State: { CONNECTING: 0, OPEN: 1, CLOSED: 2, UNSTABLE: 3 } },
    },
  };
});

import { createDfapTunnel, encodeInstruction } from '../src/session/dfap-tunnel.js';

/** Minimal WebSocket double capturing everything sent, in order. */
class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
}

describe('encodeInstruction', () => {
  it('encodes Guacamole elements as len.value,…;', () => {
    expect(encodeInstruction(['mouse', 100, 200, 1])).toBe('5.mouse,3.100,3.200,1.1;');
  });
  it('encodes an empty instruction as just the terminator', () => {
    expect(encodeInstruction([])).toBe(';');
  });
});

describe('DfapTunnel', () => {
  it('sends the DFAP1 token as the very first WebSocket frame', () => {
    const onOpen = vi.fn();
    const tunnel = createDfapTunnel({
      brokerUrl: 'wss://broker.example',
      token: 'DFAP1.aaa.bbb.ccc',
      onOpen,
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    tunnel.connect('');
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toBe('wss://broker.example/tunnel');
    // Nothing is sent before the socket opens.
    expect(ws.sent).toEqual([]);

    ws.onopen?.();

    // FIRST frame on the wire is the opaque token — no Guacamole frame precedes it.
    expect(ws.sent[0]).toBe('DFAP1.aaa.bbb.ccc');
    expect(ws.sent).toHaveLength(1);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(tunnel.isConnected()).toBe(true);
  });

  it('only emits Guacamole frames after the token, via sendMessage', () => {
    const tunnel = createDfapTunnel({
      brokerUrl: 'wss://broker.example/',
      token: 'TOKEN',
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    tunnel.connect('');
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();

    tunnel.sendMessage('size', 1024, 768);
    expect(ws.sent).toEqual(['TOKEN', encodeInstruction(['size', 1024, 768])]);
  });

  it('does not send frames before the channel is open', () => {
    const tunnel = createDfapTunnel({
      brokerUrl: 'wss://broker.example',
      token: 'TOKEN',
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    tunnel.connect('');
    const ws = FakeWebSocket.instances.at(-1)!;
    // readyState still OPEN in the fake, but the tunnel guards on its own OPEN
    // state only after onopen fired; here we simulate a not-yet-open socket.
    ws.readyState = 0;
    tunnel.sendMessage('nop');
    expect(ws.sent).toEqual([]);
  });
});
