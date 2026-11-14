/**
 * Streaming parser for the Guacamole protocol wire format.
 *
 * An instruction is `LEN.VALUE,LEN.VALUE,...;` where LEN is the element's
 * length in Unicode *code points* (not UTF-16 code units, not bytes). The
 * first element is the opcode; the rest are arguments.
 *
 * The parser buffers partial input: instructions may be split across
 * WebSocket frames (client side) or TCP segments (guacd side). `push()`
 * returns only complete instructions and keeps the remainder buffered.
 *
 * Malformed input throws {@link GuacParseError}. The tunnel treats any parse
 * error as a fatal protocol violation and terminates the session — we never
 * attempt to resynchronize a corrupt stream.
 */

export class GuacParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuacParseError';
  }
}

export interface GuacInstruction {
  opcode: string;
  args: string[];
  /** Exact wire text including the trailing ';' — forwarded verbatim on pass. */
  raw: string;
}

export interface GuacParserOptions {
  /** Max declared length of a single element, in code points. */
  maxElementLength?: number;
  /** Max buffered unparsed input, in UTF-16 code units. */
  maxBufferLength?: number;
}

const DEFAULT_MAX_ELEMENT = 65_536;
const DEFAULT_MAX_BUFFER = 1 << 20; // 1 MiB

export class GuacParser {
  private buf = '';
  private readonly maxElement: number;
  private readonly maxBuffer: number;

  constructor(opts: GuacParserOptions = {}) {
    this.maxElement = opts.maxElementLength ?? DEFAULT_MAX_ELEMENT;
    this.maxBuffer = opts.maxBufferLength ?? DEFAULT_MAX_BUFFER;
  }

  /** Number of buffered, not-yet-parseable code units (diagnostics only). */
  get pending(): number {
    return this.buf.length;
  }

  /**
   * Remove and return any buffered, not-yet-parsed input. Used when handing
   * a socket off mid-stream (e.g. after the guacd handshake completes) so the
   * bytes already read past the boundary are not lost.
   */
  drain(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  push(chunk: string): GuacInstruction[] {
    this.buf += chunk;
    if (this.buf.length > this.maxBuffer) {
      throw new GuacParseError(`parse buffer exceeded ${this.maxBuffer} code units`);
    }
    const out: GuacInstruction[] = [];
    let pos = 0;
    for (;;) {
      const parsed = this.tryParseOne(pos);
      if (parsed === null) break;
      out.push(parsed.instr);
      pos = parsed.next;
    }
    if (pos > 0) this.buf = this.buf.slice(pos);
    return out;
  }

  /** Parse one instruction starting at `start`, or null if input is incomplete. */
  private tryParseOne(start: number): { instr: GuacInstruction; next: number } | null {
    const buf = this.buf;
    const elements: string[] = [];
    let p = start;

    for (;;) {
      // -- length prefix: one or more ASCII digits, then '.'
      let lenEnd = p;
      while (lenEnd < buf.length) {
        const c = buf.charCodeAt(lenEnd);
        if (c < 0x30 || c > 0x39) break;
        lenEnd++;
      }
      if (lenEnd >= buf.length) return null; // digits may continue — wait for more input
      if (lenEnd === p) {
        throw new GuacParseError(`expected element length at offset ${p}`);
      }
      if (buf[lenEnd] !== '.') {
        throw new GuacParseError(`expected '.' after element length at offset ${lenEnd}`);
      }
      if (lenEnd - p > 8) {
        throw new GuacParseError('element length prefix too long');
      }
      const len = Number(buf.slice(p, lenEnd));
      if (len > this.maxElement) {
        throw new GuacParseError(`element length ${len} exceeds cap ${this.maxElement}`);
      }

      // -- value: exactly `len` code points
      const vStart = lenEnd + 1;
      let vEnd = vStart;
      for (let remaining = len; remaining > 0; remaining--) {
        if (vEnd >= buf.length) return null; // incomplete value
        const cu = buf.charCodeAt(vEnd);
        if (cu >= 0xd800 && cu <= 0xdbff) {
          // High surrogate: the code point spans two units. If the low half
          // hasn't arrived yet, the instruction is incomplete.
          if (vEnd + 1 >= buf.length) return null;
          vEnd += 2;
        } else {
          vEnd += 1;
        }
      }

      // -- delimiter: ',' continues the instruction, ';' terminates it
      if (vEnd >= buf.length) return null;
      const d = buf[vEnd];
      elements.push(buf.slice(vStart, vEnd));
      if (d === ',') {
        p = vEnd + 1;
        continue;
      }
      if (d === ';') {
        return {
          instr: {
            opcode: elements[0] ?? '',
            args: elements.slice(1),
            raw: buf.slice(start, vEnd + 1),
          },
          next: vEnd + 1,
        };
      }
      throw new GuacParseError(`expected ',' or ';' at offset ${vEnd}, got ${JSON.stringify(d)}`);
    }
  }
}
