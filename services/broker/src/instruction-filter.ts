/**
 * The pixel-only guarantee, enforced.
 *
 * This is layer 2 of the four isolation layers (docs/security.md) and the
 * only one fully under our control at runtime. Both directions of the
 * Guacamole instruction stream pass through here:
 *
 *  - client → guacd: strict opcode allowlist. Input events and protocol
 *    housekeeping only. A client can never open a stream, so clipboard,
 *    file upload, pipes, and parameter mutation (`argv`) are impossible.
 *
 *  - guacd → client: stream-index tracking. `blob`/`end` cannot be blanket
 *    dropped (image and audio data use them), so each stream index is
 *    classified when opened: `img`/`audio`/`video` → allowed, `file`/
 *    `clipboard`/`pipe`/`argv` → denied. Denied streams have their opening
 *    instruction dropped, a refusal `ack` (status 256 UNSUPPORTED) injected
 *    back to guacd so it closes the stream cleanly, and all subsequent
 *    `blob`/`end` for that index suppressed.
 *
 * Every dropped instruction is reported as a {@link Violation}; the tunnel
 * records them as security events against the session and terminates on
 * repeated client-side violations.
 *
 * NOTE — deviation from the original design allowlist (mouse, key, size,
 * sync, nop, disconnect): `ack` and `touch` are additionally allowed.
 * `ack` is flow control the client MUST send for server streams or image
 * delivery stalls; it opens nothing and its payload flows toward guacd,
 * not toward the client. `touch` is the touch-device equivalent of `mouse`.
 */

import { GuacParser, type GuacInstruction } from './guac/parser.js';
import { formatInstruction } from './guac/serialize.js';

export type Direction = 'c2s' | 's2c';

export interface Violation {
  direction: Direction;
  opcode: string;
  reason: string;
  /** Truncated raw instruction for the security event log. */
  sample: string;
}

export interface FilterOutput {
  /** Wire text to forward to the destination peer. */
  forward: string;
  /** Instructions to send back to the *source* peer (e.g. tunnel ping replies to the client). */
  replies: string[];
  /** Instructions to inject toward guacd (denied-stream refusal acks). */
  injectUpstream: string[];
  violations: Violation[];
}

/** Guacamole protocol status: UNSUPPORTED. Sent when refusing a denied stream. */
const STATUS_UNSUPPORTED = '256';

const SAMPLE_LIMIT = 120;

/** Client→guacd opcodes that are ever forwarded. Everything else is dropped. */
export const CLIENT_ALLOWED_OPCODES: ReadonlySet<string> = new Set([
  'sync', // mandatory frame acknowledgement — guacd disconnects without it
  'mouse',
  'key',
  'touch',
  'size', // client viewport resize
  'ack', // stream flow control for server-sent img/audio data
  'nop', // keepalive
  'disconnect',
]);

/** Max UTF-16 length of any argument on an allowed client instruction. */
const CLIENT_ARG_LIMIT = 256;

/** Server-opened stream types the client is allowed to receive. */
const STREAM_OPENERS_ALLOWED: ReadonlySet<string> = new Set(['img', 'audio', 'video']);

/** Server-opened stream types that must never reach the client. */
const STREAM_OPENERS_DENIED: ReadonlySet<string> = new Set(['file', 'clipboard', 'pipe', 'argv']);

function truncate(s: string): string {
  return s.length > SAMPLE_LIMIT ? `${s.slice(0, SAMPLE_LIMIT)}…` : s;
}

export class InstructionFilter {
  private readonly c2sParser: GuacParser;
  private readonly s2cParser: GuacParser;
  /** Server-opened stream index → allowed to reach the client? */
  private readonly serverStreams = new Map<string, boolean>();

  constructor() {
    // Client input events are tiny; a small element cap shrinks the abuse
    // surface. guacd blobs (base64 image tiles) are legitimately larger.
    this.c2sParser = new GuacParser({ maxElementLength: 8192, maxBufferLength: 64 * 1024 });
    this.s2cParser = new GuacParser();
  }

  /** Filter a chunk arriving from the client. Throws GuacParseError on malformed input. */
  clientToServer(chunk: string): FilterOutput {
    const out: FilterOutput = { forward: '', replies: [], injectUpstream: [], violations: [] };
    for (const instr of this.c2sParser.push(chunk)) {
      this.applyClientRules(instr, out);
    }
    return out;
  }

  /** Filter a chunk arriving from guacd. Throws GuacParseError on malformed input. */
  serverToClient(chunk: string): FilterOutput {
    const out: FilterOutput = { forward: '', replies: [], injectUpstream: [], violations: [] };
    for (const instr of this.s2cParser.push(chunk)) {
      this.applyServerRules(instr, out);
    }
    return out;
  }

  private violation(out: FilterOutput, direction: Direction, instr: GuacInstruction, reason: string): void {
    out.violations.push({ direction, opcode: instr.opcode, reason, sample: truncate(instr.raw) });
  }

  private applyClientRules(instr: GuacInstruction, out: FilterOutput): void {
    // Internal tunnel instructions (empty opcode) are a client↔tunnel
    // channel, never forwarded to guacd. Answer pings; drop the rest.
    if (instr.opcode === '') {
      if (instr.args[0] === 'ping') {
        out.replies.push(formatInstruction('', 'ping', ...instr.args.slice(1)));
      }
      return;
    }

    if (!CLIENT_ALLOWED_OPCODES.has(instr.opcode)) {
      this.violation(out, 'c2s', instr, 'opcode not in client allowlist');
      return;
    }

    for (const arg of instr.args) {
      if (arg.length > CLIENT_ARG_LIMIT) {
        this.violation(out, 'c2s', instr, `argument exceeds ${CLIENT_ARG_LIMIT} chars on allowed opcode`);
        return;
      }
    }

    out.forward += instr.raw;
  }

  private applyServerRules(instr: GuacInstruction, out: FilterOutput): void {
    const { opcode, args } = instr;

    if (STREAM_OPENERS_ALLOWED.has(opcode)) {
      const index = args[0];
      if (index !== undefined) this.serverStreams.set(index, true);
      out.forward += instr.raw;
      return;
    }

    if (STREAM_OPENERS_DENIED.has(opcode)) {
      const index = args[0];
      if (index !== undefined) {
        // Remember the index so in-flight blob/end are suppressed, and
        // refuse the stream so guacd closes it instead of buffering.
        this.serverStreams.set(index, false);
        out.injectUpstream.push(
          formatInstruction('ack', index, 'DisFAP: stream type not permitted', STATUS_UNSUPPORTED),
        );
      }
      this.violation(out, 's2c', instr, `denied stream type '${opcode}'`);
      return;
    }

    if (opcode === 'blob' || opcode === 'end') {
      const index = args[0] ?? '';
      const allowed = this.serverStreams.get(index);
      if (allowed === undefined) {
        // Data for a stream we never saw opened — protocol anomaly. Deny.
        this.violation(out, 's2c', instr, `${opcode} for unknown stream index ${index}`);
        return;
      }
      if (opcode === 'end') this.serverStreams.delete(index); // indices are reused after end
      if (!allowed) return; // silently suppress denied-stream data
      out.forward += instr.raw;
      return;
    }

    if (opcode === '') {
      // guacd never emits internal tunnel instructions; anything here is suspect.
      this.violation(out, 's2c', instr, 'internal instruction from server side');
      return;
    }

    // All remaining server instructions are display/session housekeeping
    // (sync, name, ready, cursor, copy, rect, png, size, error, …) with no
    // data-channel semantics: forward.
    out.forward += instr.raw;
  }
}
