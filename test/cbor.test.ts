import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { Tagged, decode, decodeItem } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';

const h = (s: string) => hexToBytes(s.replace(/\s+/g, ''));

describe('cbor decode', () => {
  it('decodes unsigned integers of every width', () => {
    expect(decode(h('00'))).toBe(0n);
    expect(decode(h('17'))).toBe(23n);
    expect(decode(h('1818'))).toBe(24n);
    expect(decode(h('1903e8'))).toBe(1000n);
    expect(decode(h('1a000f4240'))).toBe(1000000n);
    expect(decode(h('1b000000e8d4a51000'))).toBe(1000000000000n);
  });

  it('decodes negative integers', () => {
    expect(decode(h('20'))).toBe(-1n);
    expect(decode(h('3863'))).toBe(-100n);
  });

  it('decodes byte and text strings', () => {
    expect(bytesToHex(decode(h('4401020304')) as Uint8Array)).toBe('01020304');
    expect(decode(h('6161'))).toBe('a');
  });

  it('decodes arrays, maps and tags', () => {
    expect(decode(h('83010203'))).toEqual([1n, 2n, 3n]);
    const m = decode(h('a201020304')) as Map<bigint, bigint>;
    expect(m.get(1n)).toBe(2n);
    expect(m.get(3n)).toBe(4n);
    const t = decode(h('d9010281 01')) as Tagged;
    expect(t.tag).toBe(258n);
    expect(t.value).toEqual([1n]);
  });

  it('decodes simple values', () => {
    expect(decode(h('f4'))).toBe(false);
    expect(decode(h('f5'))).toBe(true);
    expect(decode(h('f6'))).toBe(null);
  });

  it('decodes indefinite-length arrays, maps and byte strings', () => {
    expect(decode(h('9f 01 02 ff'))).toEqual([1n, 2n]);
    const m = decode(h('bf 01 02 ff')) as Map<bigint, bigint>;
    expect(m.get(1n)).toBe(2n);
    expect(bytesToHex(decode(h('5f 4201 02 4103 ff')) as Uint8Array)).toBe('010203');
  });

  it('refuses the indefinite form for integers, tags and the bare break byte', () => {
    for (const bad of ['1f', '3f', 'dff6', 'ff']) expect(() => decode(h(bad))).toThrow(/cbor/);
  });

  it('reports the offset right after the decoded item', () => {
    const { value, next } = decodeItem(h('83010203 04'), 0);
    expect(value).toEqual([1n, 2n, 3n]);
    expect(next).toBe(4);
  });

  it('rejects floats and trailing garbage', () => {
    expect(() => decode(h('f93c00'))).toThrow(/float/i);
    expect(() => decode(h('01 02'))).toThrow(/trailing/i);
  });
});

describe('cbor encode', () => {
  it('uses the shortest integer encoding', () => {
    expect(bytesToHex(encode(0n))).toBe('00');
    expect(bytesToHex(encode(23n))).toBe('17');
    expect(bytesToHex(encode(24n))).toBe('1818');
    expect(bytesToHex(encode(256n))).toBe('190100');
    expect(bytesToHex(encode(70000n))).toBe('1a00011170');
    expect(bytesToHex(encode(5000000000n))).toBe('1b000000012a05f200');
    expect(bytesToHex(encode(-1n))).toBe('20');
  });

  it('encodes bytes, text, arrays, maps, tags and simple values', () => {
    expect(bytesToHex(encode(h('0102')))).toBe('420102');
    expect(bytesToHex(encode('a'))).toBe('6161');
    expect(bytesToHex(encode([1n, [2n]]))).toBe('82018102');
    expect(bytesToHex(encode(new Map<bigint, bigint>([[0n, 1n]])))).toBe('a10001');
    expect(bytesToHex(encode(new Tagged(258n, [1n])))).toBe('d901028101');
    expect(bytesToHex(encode(true))).toBe('f5');
    expect(bytesToHex(encode(null))).toBe('f6');
  });

  it('round-trips a nested structure', () => {
    const v = new Map<bigint, unknown>([
      [0n, [[h('aa'.repeat(32)), 1n]]],
      [2n, 170000n],
    ]);
    expect(decode(encode(v as never))).toEqual(v);
  });
});

describe('hexToBytes', () => {
  it('rejects a non-hex character', () => {
    expect(() => hexToBytes('1z')).toThrow(/non-hex/);
    expect(() => hexToBytes('-1')).toThrow(/non-hex/);
  });
});
