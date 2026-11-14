/**
 * Minimal, hand-written types for `guacamole-common-js`.
 *
 * The package ships JS with only loose/partial typings, so we declare exactly
 * the surface DisFAP touches — no more. Keeping this narrow is itself a small
 * safety measure: types we never declare are handlers we never wire, and the
 * ones that would open a data channel (onfile/onclipboard/onpipe) are typed as
 * `unknown` precisely so the only sound thing to assign them is `null`
 * (isolation layer 4 — see GuacsessionView).
 */
declare module 'guacamole-common-js' {
  /** Pointer state delivered by Guacamole.Mouse. */
  export interface MouseState {
    x: number;
    y: number;
    left: boolean;
    middle: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
  }

  /** The rendered display; its element is a <div> wrapping the pixel canvas. */
  export interface Display {
    getElement(): HTMLElement;
    getWidth(): number;
    getHeight(): number;
    scale(scale: number): void;
    showCursor(shown: boolean): boolean;
    onresize: ((width: number, height: number) => void) | null;
  }

  /** A Guacamole protocol status (error) object. */
  export interface Status {
    code: number;
    message?: string;
    isError(): boolean;
  }

  /**
   * The tunnel contract Guacamole.Client depends on. DisFAP implements this
   * itself (DfapTunnel) so the DFAP1 token can be sent as the very first
   * WebSocket frame, ahead of any Guacamole instruction.
   */
  export interface Tunnel {
    state: number;
    uuid: string | null;
    onerror: ((status: Status) => void) | null;
    oninstruction: ((opcode: string, args: string[]) => void) | null;
    onstatechange: ((state: number) => void) | null;
    connect(data?: string): void;
    disconnect(): void;
    sendMessage(...elements: (string | number)[]): void;
    isConnected(): boolean;
  }

  /** Streaming decoder for the Guacamole wire protocol. */
  export interface Parser {
    receive(packet: string): void;
    oninstruction: ((opcode: string, args: string[]) => void) | null;
  }

  export interface Mouse {
    onmousedown: ((state: MouseState) => void) | null;
    onmouseup: ((state: MouseState) => void) | null;
    onmousemove: ((state: MouseState) => void) | null;
    onmouseout: ((state: MouseState) => void) | null;
  }

  export interface Keyboard {
    onkeydown: ((keysym: number) => boolean | void) | null;
    onkeyup: ((keysym: number) => void) | null;
    reset(): void;
    listenTo(element: Element | Document): void;
  }

  export interface Client {
    connect(data?: string): void;
    disconnect(): void;
    getDisplay(): Display;
    sendMouseState(state: MouseState): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    sendSize(width: number, height: number): void;
    onerror: ((status: Status) => void) | null;
    onstatechange: ((state: number) => void) | null;
    onname: ((name: string) => void) | null;
    onsync: ((timestamp: number) => void) | null;
    /**
     * Data-channel handlers. Typed as `unknown` on purpose: the only value we
     * are ever allowed to assign is `null`. See isolation layer 4.
     */
    onfile: unknown;
    onclipboard: unknown;
    onpipe: unknown;
  }

  interface TunnelState {
    readonly CONNECTING: number;
    readonly OPEN: number;
    readonly CLOSED: number;
    readonly UNSTABLE: number;
  }

  interface GuacamoleStatic {
    Client: new (tunnel: Tunnel) => Client;
    Mouse: new (element: Element) => Mouse;
    Keyboard: new (element?: Element | Document | null) => Keyboard;
    Parser: new () => Parser;
    Status: (new (code: number, message?: string) => Status) & { Code: Record<string, number> };
    Tunnel: { State: TunnelState };
    WebSocketTunnel: new (tunnelURL: string) => Tunnel;
  }

  const Guacamole: GuacamoleStatic;
  export default Guacamole;
}
