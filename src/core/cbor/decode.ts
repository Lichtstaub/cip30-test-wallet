// Minimal CBOR decoder for Cardano transactions. Integers become bigint,
// byte strings Uint8Array, maps Map, tags Tagged. Floats are rejected on
// purpose, Cardano never uses them. Offsets are exposed so callers can slice
// the original bytes of any item without re-encoding it.

export class Tagged {
  constructor(
    public readonly tag: bigint,
    public readonly value: CborValue,
  ) {}
}

export type CborValue =
  | bigint
  | Uint8Array
  | string
  | CborValue[]
  | Map<CborValue, CborValue>
  | Tagged
  | boolean
  | null
  | undefined;

export interface Header {
  major: number;
  info: number;
  /** Argument value for info < 24 or the following 1/2/4/8 bytes. 0n when indefinite. */
  arg: bigint;
  indefinite: boolean;
  /** Offset of the first byte after the header. */
  next: number;
}

const BREAK = 0xff;

export function readHeader(bytes: Uint8Array, offset: number): Header {
  const initial = bytes[offset];
  if (initial === undefined) throw new Error('cbor: unexpected end of input');
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, info, arg: BigInt(info), indefinite: false, next: offset + 1 };
  if (info === 31) return { major, info, arg: 0n, indefinite: true, next: offset + 1 };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
  if (width < 0) throw new Error(`cbor: reserved additional info ${info}`);
  if (offset + 1 + width > bytes.length) throw new Error('cbor: unexpected end of input');
  let arg = 0n;
  for (let i = 0; i < width; i++) arg = (arg << 8n) | BigInt(bytes[offset + 1 + i]!);
  return { major, info, arg, indefinite: false, next: offset + 1 + width };
}

function readChunk(bytes: Uint8Array, start: number, length: bigint): Uint8Array {
  const end = start + Number(length);
  if (end > bytes.length) throw new Error('cbor: unexpected end of input');
  return bytes.slice(start, end);
}

export function decodeItem(bytes: Uint8Array, offset = 0): { value: CborValue; next: number } {
  const h = readHeader(bytes, offset);
  switch (h.major) {
    case 0:
      return { value: h.arg, next: h.next };
    case 1:
      return { value: -1n - h.arg, next: h.next };
    case 2:
    case 3: {
      let data: Uint8Array;
      let next: number;
      if (h.indefinite) {
        const chunks: Uint8Array[] = [];
        let p = h.next;
        while (bytes[p] !== BREAK) {
          const ch = readHeader(bytes, p);
          if (ch.major !== h.major || ch.indefinite) throw new Error('cbor: bad indefinite string chunk');
          chunks.push(readChunk(bytes, ch.next, ch.arg));
          p = ch.next + Number(ch.arg);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        data = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          data.set(c, o);
          o += c.length;
        }
        next = p + 1;
      } else {
        data = readChunk(bytes, h.next, h.arg);
        next = h.next + Number(h.arg);
      }
      return { value: h.major === 2 ? data : new TextDecoder().decode(data), next };
    }
    case 4: {
      const items: CborValue[] = [];
      let p = h.next;
      if (h.indefinite) {
        while (bytes[p] !== BREAK) {
          const r = decodeItem(bytes, p);
          items.push(r.value);
          p = r.next;
        }
        p += 1;
      } else {
        for (let i = 0n; i < h.arg; i++) {
          const r = decodeItem(bytes, p);
          items.push(r.value);
          p = r.next;
        }
      }
      return { value: items, next: p };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      let p = h.next;
      const readPair = () => {
        const k = decodeItem(bytes, p);
        const v = decodeItem(bytes, k.next);
        map.set(k.value, v.value);
        p = v.next;
      };
      if (h.indefinite) {
        while (bytes[p] !== BREAK) readPair();
        p += 1;
      } else {
        for (let i = 0n; i < h.arg; i++) readPair();
      }
      return { value: map, next: p };
    }
    case 6: {
      const inner = decodeItem(bytes, h.next);
      return { value: new Tagged(h.arg, inner.value), next: inner.next };
    }
    case 7: {
      if (h.info === 20) return { value: false, next: h.next };
      if (h.info === 21) return { value: true, next: h.next };
      if (h.info === 22) return { value: null, next: h.next };
      if (h.info === 23) return { value: undefined, next: h.next };
      if (h.info >= 25 && h.info <= 27) throw new Error('cbor: floats are not supported');
      throw new Error(`cbor: unsupported simple value ${h.info}`);
    }
    default:
      throw new Error(`cbor: unknown major type ${h.major}`);
  }
}

export function decode(bytes: Uint8Array): CborValue {
  const { value, next } = decodeItem(bytes, 0);
  if (next !== bytes.length) throw new Error('cbor: trailing bytes after item');
  return value;
}
