/**
 * ProtocolAdapter — the seam that lets the broker speak more than one
 * remoting protocol without a rewrite (ADR-003).
 *
 * Adapter #1 is guacd (this MVP). Adapter #2 is planned as NICE DCV for GPU
 * workloads, where the Guacamole wire protocol (tiled images, not video)
 * cannot deliver acceptable framerates. The tunnel only ever sees this
 * interface; it knows nothing about guacd specifically.
 *
 * The credential is passed to `connect()` and consumed here. It is fetched
 * from Vault by the tunnel immediately before this call and never leaves the
 * server — this interface is the last place it exists in the process.
 */

import type { GuacInstruction } from '../guac/parser.js';

/** What the session resolver knows about a session's target VM. */
export interface SessionTarget {
  sid: string;
  protocol: 'rdp' | 'vnc' | 'ssh';
  host: string;
  port: number;
  /** Display geometry requested by the client at connect time. */
  width: number;
  height: number;
  dpi: number;
  /** Recording settings; when enabled the adapter tells guacd to record. */
  recording?: {
    path: string;
    name: string;
  };
}

/** Secret material, fetched server-side, consumed by the adapter only. */
export interface SessionCredential {
  username: string;
  password?: string;
  /** For SSH/cert-based auth. */
  privateKey?: string;
}

/**
 * A live, bidirectional protocol connection. `onInstruction` fires for every
 * parsed instruction coming *from* the remote (server→client direction).
 * `send()` writes raw wire text *to* the remote (client→server direction).
 */
export interface ProtocolConnection {
  /** Backend connection identifier (e.g. guacd's $-prefixed id), for correlation. */
  readonly connectionId?: string;
  /** Raw wire text from the remote peer, already framed as complete instructions is NOT guaranteed. */
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
  /** Write raw wire text toward the remote peer. */
  send(wire: string): void;
  close(reason: string): void;
}

export interface ProtocolAdapter {
  readonly name: string;
  connect(target: SessionTarget, credential: SessionCredential): Promise<ProtocolConnection>;
}

/** Re-export for adapters that need to reason about parsed instructions. */
export type { GuacInstruction };
