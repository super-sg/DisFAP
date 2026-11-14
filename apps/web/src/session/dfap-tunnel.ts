/**
 * DfapTunnel — a Guacamole `Tunnel` that speaks the DisFAP broker's WebSocket
 * contract: the DFAP1 connect handle is sent as the *very first* WebSocket
 * frame, and only then do Guacamole protocol frames flow.
 *
 * Why not stock `Guacamole.WebSocketTunnel`? That tunnel carries its connect
 * data in the URL query string, so the first *message* on the wire is a
 * Guacamole instruction — but the broker reads the first message as the opaque
 * token (services/broker/src/tunnel.ts: phase `await_token`). This tunnel keeps
 * the rest of Guacamole's machinery (it reuses `Guacamole.Parser` for inbound
 * decoding, exactly like the stock tunnel) and only changes the handshake so
 * the token leads.
 *
 * The token is the ONLY thing this tunnel injects. No hostname, credential, or
 * connection parameter is ever sent from the client — those live server-side
 * (docs/security.md, Guarantee 2).
 */
import Guacamole, { type Status, type Tunnel } from 'guacamole-common-js';

export interface DfapTunnelOptions {
  /** Broker WebSocket base URL, e.g. "wss://broker.example". */
  brokerUrl: string;
  /** Opaque DFAP1 handle to send as the first frame. */
  token: string;
  /** WebSocket path on the broker. Defaults to "/tunnel". */
  path?: string;
  /** Fired once the channel is open and the token has been sent. */
  onOpen?: () => void;
  /** Injectable WebSocket constructor (tests). Defaults to global WebSocket. */
  webSocketImpl?: typeof WebSocket;
}

/** Guacamole protocol status codes we surface on abnormal transport failure. */
const STATUS_UPSTREAM_ERROR = 0x0208;

/**
 * Encode Guacamole protocol elements into a single instruction:
 *   `len.value,len.value,...;`
 * Lengths are counted the same way `Guacamole.WebSocketTunnel` counts them —
 * UTF-16 code units (`String#length`) — so guacd's parser stays in sync.
 */
export function encodeInstruction(elements: readonly (string | number)[]): string {
  let message = '';
  for (const element of elements) {
    const value = String(element);
    message += `${value.length}.${value},`;
  }
  // Replace the trailing comma with the instruction terminator.
  return message.length > 0 ? `${message.slice(0, -1)};` : ';';
}

export class DfapTunnel implements Tunnel {
  public state: number;
  public uuid: string | null = null;
  public onerror: ((status: Status) => void) | null = null;
  public oninstruction: ((opcode: string, args: string[]) => void) | null = null;
  public onstatechange: ((state: number) => void) | null = null;

  private socket: WebSocket | null = null;
  private parser: InstanceType<typeof Guacamole.Parser> | null = null;
  private readonly opts: DfapTunnelOptions;
  private readonly States = Guacamole.Tunnel.State;

  constructor(opts: DfapTunnelOptions) {
    this.opts = opts;
    this.state = this.States.CLOSED;
  }

  private setState(state: number): void {
    if (state === this.state) return;
    this.state = state;
    this.onstatechange?.(state);
  }

  connect(_data?: string): void {
    // `_data` (Guacamole connect params) is deliberately ignored: the broker
    // injects all connection parameters server-side, and the only thing the
    // client is permitted to send ahead of frames is the opaque token.
    const WS = this.opts.webSocketImpl ?? WebSocket;
    const url = `${this.opts.brokerUrl.replace(/\/+$/, '')}${this.opts.path ?? '/tunnel'}`;

    // NOTE: no subprotocol is offered. The broker does not negotiate one, and a
    // browser must fail the connection if it offers a subprotocol the server
    // does not select.
    const socket = new WS(url);
    this.socket = socket;
    this.setState(this.States.CONNECTING);

    const parser = new Guacamole.Parser();
    parser.oninstruction = (opcode, args) => this.oninstruction?.(opcode, args);
    this.parser = parser;

    socket.onopen = () => {
      // FIRST FRAME ON THE WIRE: the DFAP1 handle, by itself. Everything after
      // this is Guacamole protocol.
      try {
        socket.send(this.opts.token);
      } catch (err) {
        this.fail(`failed to send connect handle: ${(err as Error).message}`);
        return;
      }
      this.setState(this.States.OPEN);
      this.opts.onOpen?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      // The broker only ever sends UTF-8 text (Guacamole is a text protocol);
      // anything else is treated as a protocol violation and closed.
      if (typeof event.data !== 'string') {
        this.fail('unexpected binary frame from broker');
        return;
      }
      try {
        parser.receive(event.data);
      } catch (err) {
        this.fail(`protocol parse error: ${(err as Error).message}`);
      }
    };

    socket.onerror = () => {
      // The Event carries no useful detail in browsers; report generically.
      this.emitError('websocket transport error');
    };

    socket.onclose = () => {
      this.setState(this.States.CLOSED);
      this.cleanup();
    };
  }

  disconnect(): void {
    // Intentional teardown. Move to CLOSED first so listeners see a clean stop
    // (the socket's async onclose will be a no-op after cleanup()).
    this.setState(this.States.CLOSED);
    const socket = this.socket;
    this.cleanup();
    try {
      socket?.close(1000, 'client disconnect');
    } catch {
      /* already closing */
    }
  }

  sendMessage(...elements: (string | number)[]): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(encodeInstruction(elements));
  }

  isConnected(): boolean {
    return this.state === this.States.OPEN;
  }

  private emitError(message: string): void {
    const status = makeStatus(STATUS_UPSTREAM_ERROR, message);
    this.onerror?.(status);
  }

  private fail(message: string): void {
    this.emitError(message);
    this.disconnect();
  }

  private cleanup(): void {
    const socket = this.socket;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      this.socket = null;
    }
    if (this.parser) {
      this.parser.oninstruction = null;
      this.parser = null;
    }
  }
}

/** Construct a Guacamole Status, tolerating environments without the ctor. */
function makeStatus(code: number, message: string): Status {
  try {
    return new Guacamole.Status(code, message);
  } catch {
    return { code, message, isError: () => true };
  }
}

/** Factory used by GuacsessionView; keeps `new` out of the component body. */
export function createDfapTunnel(opts: DfapTunnelOptions): DfapTunnel {
  return new DfapTunnel(opts);
}
