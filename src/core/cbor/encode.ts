import { concat } from '../bytes.js';
import { Tagged, type CborValue } from './decode.js';

function header(major: number, arg: bigint): Uint8Array {
  const m = major << 5;
  if (arg < 24n) return Uint8Array.of(m | Number(arg));
  if (arg < 0x100n) return Uint8Array.of(m | 24, Number(arg));
  if (arg < 0x10000n) return Uint8Array.of(m | 25, Number(arg >> 8n), Number(arg & 0xffn));
  if (arg < 0x100000000n) {
    return Uint8Array.of(m | 26, Number(arg >> 24n), Number((arg >> 16n) & 0xffn), Number((arg >> 8n) & 0xffn), Number(arg & 0xffn));
  }
  const out = new Uint8Array(9);
  out[0] = m | 27;
  let v = arg;
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function encode(value: CborValue): Uint8Array {
  if (typeof value === 'bigint') {
    return value >= 0n ? header(0, value) : header(1, -1n - value);
  }
  if (value instanceof Uint8Array) return concat(header(2, BigInt(value.length)), value);
  if (typeof value === 'string') {
    const data = new TextEncoder().encode(value);
    return concat(header(3, BigInt(data.length)), data);
  }
  if (Array.isArray(value)) return concat(header(4, BigInt(value.length)), ...value.map(encode));
  if (value instanceof Map) {
    const parts: Uint8Array[] = [header(5, BigInt(value.size))];
    for (const [k, v] of value) parts.push(encode(k), encode(v));
    return concat(...parts);
  }
  if (value instanceof Tagged) return concat(header(6, value.tag), encode(value.value));
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  if (value === undefined) return Uint8Array.of(0xf7);
  throw new Error('cbor: unsupported value');
}
