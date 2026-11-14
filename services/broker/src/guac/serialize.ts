/** Encoding helpers for the Guacamole wire format (see parser.ts for format). */

/** Length in Unicode code points — the unit the Guacamole protocol counts in. */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

export function formatInstruction(opcode: string, ...args: string[]): string {
  let out = '';
  const all = [opcode, ...args];
  for (let i = 0; i < all.length; i++) {
    const e = all[i]!;
    out += `${codePointLength(e)}.${e}`;
    out += i === all.length - 1 ? ';' : ',';
  }
  return out;
}
