import { describe, expect, it } from 'vitest';
import { GuacParseError, GuacParser } from '../src/guac/parser.js';

describe('GuacParser', () => {
  it('parses a simple instruction', () => {
    const p = new GuacParser();
    const out = p.push('5.mouse,3.100,3.200;');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ opcode: 'mouse', args: ['100', '200'], raw: '5.mouse,3.100,3.200;' });
  });

  it('parses multiple instructions in one chunk', () => {
    const p = new GuacParser();
    const out = p.push('4.sync,8.12345678;3.nop;3.key,2.65,1.1;');
    expect(out.map((i) => i.opcode)).toEqual(['sync', 'nop', 'key']);
    expect(out[2]!.args).toEqual(['65', '1']);
  });

  it('parses empty elements and empty opcodes (internal tunnel instructions)', () => {
    const p = new GuacParser();
    const out = p.push('0.;0.,4.ping,13.1721600000000;');
    expect(out[0]).toMatchObject({ opcode: '', args: [] });
    expect(out[1]).toMatchObject({ opcode: '', args: ['ping', '1721600000000'] });
  });

  it('reassembles an instruction split at every possible boundary', () => {
    const wire = '5.mouse,3.100,3.200;4.sync,8.12345678;';
    for (let split = 1; split < wire.length; split++) {
      const p = new GuacParser();
      const out = [...p.push(wire.slice(0, split)), ...p.push(wire.slice(split))];
      expect(out.map((i) => i.raw).join('')).toBe(wire);
      expect(out).toHaveLength(2);
      expect(p.pending).toBe(0);
    }
  });

  it('counts length in code points, not UTF-16 units', () => {
    // '🔒' is one code point but two UTF-16 units; a byte- or unit-counting
    // parser would misparse the stream after it.
    const p = new GuacParser();
    const out = p.push('4.name,2.🔒a;3.nop;');
    expect(out[0]!.args).toEqual(['🔒a']);
    expect(out[1]!.opcode).toBe('nop');
  });

  it('waits when a surrogate pair is split across chunks', () => {
    const wire = '4.name,2.🔒a;';
    const emojiStart = wire.indexOf('🔒');
    const p = new GuacParser();
    expect(p.push(wire.slice(0, emojiStart + 1))).toEqual([]); // high surrogate only
    const out = p.push(wire.slice(emojiStart + 1));
    expect(out[0]!.args).toEqual(['🔒a']);
  });

  it('rejects a missing length prefix', () => {
    expect(() => new GuacParser().push('mouse,3.100;')).toThrow(GuacParseError);
  });

  it('rejects a bad delimiter', () => {
    expect(() => new GuacParser().push('3.nop|')).toThrow(GuacParseError);
  });

  it('rejects an element exceeding the cap', () => {
    const p = new GuacParser({ maxElementLength: 10 });
    expect(() => p.push('99.x')).toThrow(GuacParseError);
  });

  it('rejects an absurd length prefix before allocating anything', () => {
    expect(() => new GuacParser().push('999999999.x')).toThrow(GuacParseError);
  });

  it('rejects unbounded buffering of non-terminated input', () => {
    const p = new GuacParser({ maxBufferLength: 100 });
    expect(() => p.push(`90.${'a'.repeat(120)}`)).toThrow(GuacParseError);
  });

  it('holds incomplete input across pushes without emitting', () => {
    const p = new GuacParser();
    expect(p.push('5.mou')).toEqual([]);
    expect(p.push('se,1.0,1.0')).toEqual([]);
    expect(p.push(';')).toHaveLength(1);
  });
});
