/**
 * guacd handshake client (adapter #1).
 *
 * Implements the Guacamole protocol handshake against a guacd instance:
 *
 *   broker → guacd:  select,<protocol>
 *   guacd  → broker: args,<VERSION>,<param1>,<param2>,…
 *   broker → guacd:  size,<w>,<h>,<dpi>
 *                    audio,<mimetypes…>
 *                    video
 *                    image,<mimetypes…>
 *                    connect,<v1>,<v2>,…      (values positionally matching args)
 *   guacd  → broker: ready,<$connectionId>
 *
 * After `ready`, the connection is live and raw wire text flows in both
 * directions — the tunnel pipes it through the InstructionFilter.
 *
 * The credential (username/password) and the pixel-only lockdown flags
 * (disable-copy, disable-paste, enable-drive=false, …) are injected into the
 * `connect` values *here*, server-side. They are never sent to the browser.
 *
 * A single persistent 'data' listener owns the socket for its entire life.
 * During the handshake it parses; once `ready` arrives it switches to raw
 * forwarding and buffers anything that arrived in the same segment until the
 * consumer attaches `onData` — so no frame is ever lost at the handoff and
 * there is no listener-swap race.
 *
 * mTLS: in production guacd listens with TLS on 4822 and the broker presents a
 * client cert. That is a socket-factory concern injected via `connectSocket`;
 * this class is transport-agnostic.
 */

import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { GuacParser, type GuacInstruction } from '../guac/parser.js';
import { formatInstruction } from '../guac/serialize.js';
import type { ProtocolConnection, SessionCredential, SessionTarget } from './adapter.js';

export interface GuacdEndpoint {
  host: string;
  port: number;
  tls?:
    | false
    | {
        ca?: string;
        cert: string;
        key: string;
        /** SNI / cert-name verification target. */
        servername?: string;
      };
}

export interface GuacdClientOptions {
  endpoint: GuacdEndpoint;
  handshakeTimeoutMs?: number;
  /** Injectable for tests. Returns a connected duplex socket. */
  connectSocket?: (endpoint: GuacdEndpoint) => Socket;
}

const DEFAULT_HANDSHAKE_TIMEOUT = 10_000;

/** Client media capabilities advertised during the handshake. */
const AUDIO_MIMETYPES = ['audio/L16'];
const IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Connection parameter values that enforce pixel-only at the guacd layer
 * (isolation layer 1, docs/security.md). Applied on top of whatever the
 * protocol's args require. Any of these that guacd doesn't recognize for the
 * chosen protocol are simply ignored by guacd.
 */
const LOCKDOWN_PARAMS: Readonly<Record<string, string>> = {
  'disable-copy': 'true',
  'disable-paste': 'true',
  'enable-drive': 'false',
  'enable-audio-input': 'false',
  'enable-printing': 'false',
  'disable-download': 'true',
  'disable-upload': 'true',
};

export class GuacdHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuacdHandshakeError';
  }
}

function defaultConnect(endpoint: GuacdEndpoint): Socket {
  if (endpoint.tls) {
    return tlsConnect({
      host: endpoint.host,
      port: endpoint.port,
      ca: endpoint.tls.ca,
      cert: endpoint.tls.cert,
      key: endpoint.tls.key,
      servername: endpoint.tls.servername ?? endpoint.host,
    }) as unknown as Socket;
  }
  return netConnect({ host: endpoint.host, port: endpoint.port });
}

/**
 * Build the ordered `connect` values that positionally match the parameter
 * names guacd listed in `args` (excluding the leading VERSION element).
 * Unlisted params are dropped; listed-but-unset params become empty strings.
 */
export function buildConnectValues(argNames: string[], params: Record<string, string>): string[] {
  return argNames.map((name) => params[name] ?? '');
}

/** Assemble the full parameter map for a target: protocol conn params + lockdown. */
export function buildProtocolParams(
  target: SessionTarget,
  credential: SessionCredential,
): Record<string, string> {
  const params: Record<string, string> = {
    hostname: target.host,
    port: String(target.port),
    username: credential.username,
    ...(credential.password !== undefined ? { password: credential.password } : {}),
    ...LOCKDOWN_PARAMS,
  };
  if (target.protocol === 'rdp') {
    params['security'] = 'any';
    params['ignore-cert'] = 'true';
    params['resize-method'] = 'display-update';
  }
  if (target.recording) {
    params['recording-path'] = target.recording.path;
    params['recording-name'] = target.recording.name;
    params['create-recording-path'] = 'true';
  }
  return params;
}

/**
 * A live guacd connection presented as a transport-neutral ProtocolConnection.
 * Post-`ready` bytes that arrived before the consumer registered `onData` are
 * buffered in `pending` and flushed on registration.
 */
class GuacdConnection implements ProtocolConnection {
  readonly connectionId: string;
  private readonly socket: Socket;
  private dataHandler: ((chunk: string) => void) | null = null;
  private pending = '';
  private closed = false;

  constructor(socket: Socket, connectionId: string, leftover: string) {
    this.socket = socket;
    this.connectionId = connectionId;
    this.pending = leftover;
  }

  /** Called by GuacdClient for every post-ready chunk from the socket. */
  feedRaw(chunk: string): void {
    if (this.dataHandler) this.dataHandler(chunk);
    else this.pending += chunk;
  }

  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler;
    if (this.pending.length > 0) {
      const buffered = this.pending;
      this.pending = '';
      handler(buffered);
    }
  }
  onClose(handler: (reason: string) => void): void {
    this.socket.on('close', () => handler('guacd socket closed'));
  }
  onError(handler: (err: Error) => void): void {
    this.socket.on('error', handler);
  }
  send(wire: string): void {
    if (!this.closed && this.socket.writable) this.socket.write(wire, 'utf8');
  }
  close(_reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

export class GuacdClient {
  private readonly endpoint: GuacdEndpoint;
  private readonly handshakeTimeoutMs: number;
  private readonly connectSocket: (endpoint: GuacdEndpoint) => Socket;

  constructor(opts: GuacdClientOptions) {
    this.endpoint = opts.endpoint;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT;
    this.connectSocket = opts.connectSocket ?? defaultConnect;
  }

  /** Perform the full handshake and return a live ProtocolConnection. */
  async open(target: SessionTarget, credential: SessionCredential): Promise<ProtocolConnection> {
    const socket = this.connectSocket(this.endpoint);
    const parser = new GuacParser();
    const params = buildProtocolParams(target, credential);

    return await new Promise<ProtocolConnection>((resolve, reject) => {
      let settled = false;
      let phase: 'await_args' | 'await_ready' | 'streaming' = 'await_args';
      let conn: GuacdConnection | null = null;

      const timer = setTimeout(() => {
        fail(new GuacdHandshakeError(`handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer.unref === 'function') timer.unref();

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };

      const write = (wire: string): void => {
        socket.write(wire, 'utf8');
      };

      const onData = (buf: Buffer): void => {
        const text = buf.toString('utf8');
        if (phase === 'streaming') {
          conn!.feedRaw(text);
          return;
        }
        let instrs: GuacInstruction[];
        try {
          instrs = parser.push(text);
        } catch (err) {
          fail(new GuacdHandshakeError(`malformed handshake data: ${(err as Error).message}`));
          return;
        }
        for (let idx = 0; idx < instrs.length; idx++) {
          const instr = instrs[idx]!;
          if (phase === 'await_args') {
            if (instr.opcode === 'error') {
              fail(new GuacdHandshakeError(`guacd error during handshake: ${instr.args.join(' ')}`));
              return;
            }
            if (instr.opcode !== 'args') continue;
            const argNames = instr.args.slice(1); // drop leading VERSION element
            write(formatInstruction('size', String(target.width), String(target.height), String(target.dpi)));
            write(formatInstruction('audio', ...AUDIO_MIMETYPES));
            write(formatInstruction('video'));
            write(formatInstruction('image', ...IMAGE_MIMETYPES));
            write(formatInstruction('connect', ...buildConnectValues(argNames, params)));
            phase = 'await_ready';
            continue;
          }
          // phase === 'await_ready'
          if (instr.opcode === 'error') {
            fail(new GuacdHandshakeError(`guacd refused connection: ${instr.args.join(' ')}`));
            return;
          }
          if (instr.opcode === 'ready') {
            const connectionId = instr.args[0] ?? '';
            if (!connectionId.startsWith('$')) {
              fail(new GuacdHandshakeError(`malformed ready id: ${JSON.stringify(connectionId)}`));
              return;
            }
            // Anything after `ready` in this same segment is live stream data.
            const leftover = instrs.slice(idx + 1).map((i) => i.raw).join('') + parser.drain();
            conn = new GuacdConnection(socket, connectionId, leftover);
            phase = 'streaming';
            settled = true;
            clearTimeout(timer);
            resolve(conn);
            return;
          }
        }
      };

      socket.on('data', onData);
      socket.on('error', (err) => fail(err));
      socket.on('close', () => fail(new GuacdHandshakeError('socket closed during handshake')));

      const startHandshake = (): void => write(formatInstruction('select', target.protocol));
      if (this.endpoint.tls) socket.once('secureConnect', startHandshake);
      else socket.once('connect', startHandshake);
    });
  }
}
