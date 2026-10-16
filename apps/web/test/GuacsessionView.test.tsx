import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Isolation layer 4 regression guard. The load-bearing assertions:
 *   - client.onfile / onclipboard / onpipe are set to null (never a handler)
 *   - the input overlay refuses contextmenu / dragstart / drop
 *
 * guacamole-common-js is mocked so no real WebSocket/canvas is needed; the
 * fake Client records itself so the test can inspect the handlers the
 * component assigned.
 */
vi.mock('guacamole-common-js', () => {
  const clients: FakeClient[] = [];

  class FakeDisplay {
    getElement(): HTMLElement {
      return document.createElement('div');
    }
    getWidth(): number {
      return 0;
    }
    getHeight(): number {
      return 0;
    }
    scale(): void {}
    showCursor(): boolean {
      return true;
    }
    onresize: ((w: number, h: number) => void) | null = null;
  }

  class FakeClient {
    onfile: unknown = () => 'DANGER: default handler present';
    onclipboard: unknown = () => 'DANGER: default handler present';
    onpipe: unknown = () => 'DANGER: default handler present';
    onerror: unknown = null;
    onstatechange: unknown = null;
    onname: unknown = null;
    onsync: unknown = null;
    private readonly display = new FakeDisplay();
    constructor() {
      clients.push(this);
    }
    connect(): void {}
    disconnect(): void {}
    getDisplay(): FakeDisplay {
      return this.display;
    }
    sendMouseState(): void {}
    sendKeyEvent(): void {}
    sendSize(): void {}
  }

  class FakeMouse {
    onmousedown: unknown = null;
    onmouseup: unknown = null;
    onmousemove: unknown = null;
    onmouseout: unknown = null;
    constructor(_el: Element) {}
  }

  class FakeKeyboard {
    onkeydown: unknown = null;
    onkeyup: unknown = null;
    constructor(_el?: Element | Document | null) {}
    reset(): void {}
    listenTo(): void {}
  }

  class FakeParser {
    oninstruction: unknown = null;
    receive(): void {}
  }

  return {
    default: {
      Client: FakeClient,
      Mouse: FakeMouse,
      Keyboard: FakeKeyboard,
      Parser: FakeParser,
      Status: class {
        constructor(
          public code: number,
          public message?: string,
        ) {}
        isError(): boolean {
          return true;
        }
      },
      Tunnel: { State: { CONNECTING: 0, OPEN: 1, CLOSED: 2, UNSTABLE: 3 } },
      // Test-only handle onto the constructed clients.
      __clients: clients,
    },
  };
});

import Guacamole from 'guacamole-common-js';
import { GuacsessionView } from '../src/session/GuacsessionView.js';

function lastClient(): { onfile: unknown; onclipboard: unknown; onpipe: unknown } {
  const clients = (Guacamole as unknown as { __clients: unknown[] }).__clients;
  return clients[clients.length - 1] as { onfile: unknown; onclipboard: unknown; onpipe: unknown };
}

describe('GuacsessionView — isolation layer 4', () => {
  it('nulls the file, clipboard, and pipe handlers on mount', () => {
    render(<GuacsessionView brokerUrl="wss://broker.example" token="DFAP1.x.y.z" />);
    const client = lastClient();
    expect(client.onfile).toBeNull();
    expect(client.onclipboard).toBeNull();
    expect(client.onpipe).toBeNull();
  });

  it('refuses context menu, drag, and drop on the input surface', () => {
    const { container } = render(<GuacsessionView brokerUrl="wss://broker.example" token="DFAP1.x.y.z" />);
    const overlay = container.querySelector('[aria-label="Remote session input surface"]');
    expect(overlay).not.toBeNull();

    for (const type of ['contextmenu', 'dragstart', 'dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      overlay!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });
});
