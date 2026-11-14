import { describe, expect, it } from 'vitest';
import { InstructionFilter } from '../src/instruction-filter.js';
import { formatInstruction } from '../src/guac/serialize.js';

const i = formatInstruction;

describe('InstructionFilter — client → guacd', () => {
  it.each([
    i('sync', '12345678'),
    i('mouse', '100', '200', '1'),
    i('key', '65', '1'),
    i('touch', '0', '10', '10', '5', '5', '0', '1'),
    i('size', '1920', '1080', '96'),
    i('ack', '3', 'OK', '0'),
    i('nop'),
    i('disconnect'),
  ])('forwards allowed instruction verbatim: %s', (wire) => {
    const f = new InstructionFilter();
    const out = f.clientToServer(wire);
    expect(out.forward).toBe(wire);
    expect(out.violations).toEqual([]);
  });

  it.each([
    ['clipboard', i('clipboard', '1', 'text/plain')],
    ['file', i('file', '2', 'text/plain', 'stolen.txt')],
    ['pipe', i('pipe', '3', 'application/octet-stream', 'exfil')],
    ['argv', i('argv', '4', 'text/plain', 'recording-name')],
    ['blob', i('blob', '1', 'c2VjcmV0')],
    ['end', i('end', '1')],
    ['put', i('put', '1', '5', 'text/plain', '/etc/passwd')],
    ['get', i('get', '1', '/etc/shadow')],
    ['audio', i('audio', '1', 'audio/L16')],
    ['select', i('select', 'rdp')],
    ['connect', i('connect', 'rdp')],
    ['made-up opcode', i('exfiltrate', 'everything')],
  ])('drops %s and records a violation', (_label, wire) => {
    const f = new InstructionFilter();
    const out = f.clientToServer(wire);
    expect(out.forward).toBe('');
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]!.direction).toBe('c2s');
  });

  it('filters a mixed batch, preserving order of allowed instructions', () => {
    const f = new InstructionFilter();
    const wire = i('mouse', '1', '1') + i('clipboard', '9', 'text/plain') + i('key', '65', '1') + i('sync', '5');
    const out = f.clientToServer(wire);
    expect(out.forward).toBe(i('mouse', '1', '1') + i('key', '65', '1') + i('sync', '5'));
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]!.opcode).toBe('clipboard');
  });

  it('answers tunnel pings without forwarding them to guacd', () => {
    const f = new InstructionFilter();
    const out = f.clientToServer(i('', 'ping', '1721600000000'));
    expect(out.forward).toBe('');
    expect(out.replies).toEqual([i('', 'ping', '1721600000000')]);
    expect(out.violations).toEqual([]);
  });

  it('drops non-ping internal instructions silently', () => {
    const f = new InstructionFilter();
    const out = f.clientToServer(i('', 'whatever', 'x'));
    expect(out.forward).toBe('');
    expect(out.replies).toEqual([]);
  });

  it('drops allowed opcodes with oversized arguments (covert-channel guard)', () => {
    const f = new InstructionFilter();
    const out = f.clientToServer(i('key', 'A'.repeat(300), '1'));
    expect(out.forward).toBe('');
    expect(out.violations[0]!.reason).toMatch(/exceeds/);
  });

  it('never forwards a partial instruction across chunk boundaries', () => {
    const f = new InstructionFilter();
    const wire = i('mouse', '100', '200');
    const first = f.clientToServer(wire.slice(0, 7));
    expect(first.forward).toBe('');
    const second = f.clientToServer(wire.slice(7));
    expect(second.forward).toBe(wire);
  });

  it('rejects a smuggled instruction inside an over-length element', () => {
    // A length prefix that would swallow a following legitimate delimiter
    // must parse as data, not be re-interpreted.
    const f = new InstructionFilter();
    const out = f.clientToServer(i('key', '65;4.file', '1'));
    // The ';4.file' is argument *data*, not a new instruction — the whole
    // thing is one 'key' instruction with a weird arg, which is oversized? No:
    // it's short, so it forwards as an odd-but-harmless key arg.
    expect(out.forward).toBe(i('key', '65;4.file', '1'));
    expect(out.violations).toEqual([]);
  });
});

describe('InstructionFilter — guacd → client', () => {
  it('passes display housekeeping through untouched', () => {
    const f = new InstructionFilter();
    const wire =
      i('ready', '$conn') + i('name', 'DisFAP session') + i('size', '0', '1920', '1080') + i('sync', '99') + i('cursor', '0', '0', '1', '0', '0', '16', '16');
    const out = f.serverToClient(wire);
    expect(out.forward).toBe(wire);
    expect(out.violations).toEqual([]);
  });

  it('passes img streams including their blobs and end', () => {
    const f = new InstructionFilter();
    const wire = i('img', '7', '12', '0', 'image/png', '0', '0') + i('blob', '7', 'aWFtYXBpeGVs') + i('end', '7');
    const out = f.serverToClient(wire);
    expect(out.forward).toBe(wire);
    expect(out.injectUpstream).toEqual([]);
  });

  it('passes audio streams', () => {
    const f = new InstructionFilter();
    const wire = i('audio', '2', 'audio/L16;rate=44100') + i('blob', '2', 'c291bmQ=') + i('end', '2');
    expect(f.serverToClient(wire).forward).toBe(wire);
  });

  it.each(['file', 'clipboard', 'pipe', 'argv'])(
    'denies a %s stream: drops opener, suppresses blobs/end, refuses upstream',
    (opcode) => {
      const f = new InstructionFilter();
      const opener =
        opcode === 'file'
          ? i('file', '4', 'text/plain', 'secrets.txt')
          : i(opcode, '4', 'text/plain');
      const out = f.serverToClient(opener + i('blob', '4', 'c2VjcmV0ZGF0YQ==') + i('end', '4'));
      expect(out.forward).toBe('');
      expect(out.injectUpstream).toEqual([i('ack', '4', 'DisFAP: stream type not permitted', '256')]);
      expect(out.violations).toHaveLength(1);
      expect(out.violations[0]).toMatchObject({ direction: 's2c', opcode });
    },
  );

  it('suppresses only the denied stream when interleaved with an allowed one', () => {
    const f = new InstructionFilter();
    const wire =
      i('img', '1', '12', '0', 'image/png', '0', '0') +
      i('clipboard', '2', 'text/plain') +
      i('blob', '1', 'cGl4ZWxz') +
      i('blob', '2', 'c3RvbGVu') +
      i('end', '2') +
      i('end', '1');
    const out = f.serverToClient(wire);
    expect(out.forward).toBe(
      i('img', '1', '12', '0', 'image/png', '0', '0') + i('blob', '1', 'cGl4ZWxz') + i('end', '1'),
    );
    expect(out.forward).not.toContain('c3RvbGVu');
  });

  it('handles stream index reuse: denied then reopened as allowed', () => {
    const f = new InstructionFilter();
    f.serverToClient(i('file', '5', 'text/plain', 'x') + i('end', '5'));
    const out = f.serverToClient(i('img', '5', '12', '0', 'image/png', '0', '0') + i('blob', '5', 'b2s='));
    expect(out.forward).toContain('b2s=');
    expect(out.violations).toEqual([]);
  });

  it('drops blobs for stream indices never opened', () => {
    const f = new InstructionFilter();
    const out = f.serverToClient(i('blob', '9', 'bXlzdGVyeQ=='));
    expect(out.forward).toBe('');
    expect(out.violations[0]!.reason).toMatch(/unknown stream/);
  });

  it('flags internal instructions arriving from the server side', () => {
    const f = new InstructionFilter();
    const out = f.serverToClient(i('', 'ping', '1'));
    expect(out.forward).toBe('');
    expect(out.violations).toHaveLength(1);
  });

  it('end-to-end: a clipboard exfiltration attempt leaks zero payload bytes', () => {
    const f = new InstructionFilter();
    const secret = Buffer.from('CONFIDENTIAL-DEAL-TERMS').toString('base64');
    let clientSees = '';
    // Simulate guacd flushing in awkward chunk sizes.
    const wire =
      i('sync', '1') + i('clipboard', '3', 'text/plain') + i('blob', '3', secret) + i('end', '3') + i('sync', '2');
    for (let p = 0; p < wire.length; p += 5) {
      clientSees += f.serverToClient(wire.slice(p, p + 5)).forward;
    }
    expect(clientSees).toBe(i('sync', '1') + i('sync', '2'));
    expect(clientSees).not.toContain(secret);
  });
});
