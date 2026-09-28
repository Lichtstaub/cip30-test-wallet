// BIP32-Ed25519 as Cardano uses it: the Icarus master key (CIP-3) and the
// V2 child derivation. Node only, the page receives finished extended keys.
// Verified byte for byte against CSL in test/derive-bip32.test.ts.
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concat } from '../core/bytes.js';

// kL (32) || kR (32) || chain code (32), the layout CSL's Bip32PrivateKey uses.
export type Bip32Key = Uint8Array;

export const HARDENED = 0x80000000;

const Point = ed25519.Point;
const ORDER = Point.Fn.ORDER;

// Icarus master key: PBKDF2-HMAC-SHA512 with the passphrase as password and
// the BIP39 entropy as salt, then the Ed25519 bit clamp on kL. Clearing bit
// 253 as well (the 0x1f mask) is what keeps every derived kL below 2^255.
export function rootKey(entropy: Uint8Array, passphrase: Uint8Array = new Uint8Array()): Bip32Key {
  const key = pbkdf2(sha512, passphrase, entropy, { c: 4096, dkLen: 96 });
  key[0]! &= 0b1111_1000;
  key[31]! &= 0b0001_1111;
  key[31]! |= 0b0100_0000;
  return key;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]!);
  return r;
}

function indexBytes(index: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, index, true);
  return out;
}

// kL + 8 * zL[0..28], computed over 32 little endian bytes. A carry out of
// the top byte is dropped, as in the reference implementations.
function addMul8(kL: Uint8Array, zL: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const z = i < 28 ? (zL[i]! << 3) & 0xff : 0;
    const prev = i > 0 && i <= 28 ? zL[i - 1]! >> 5 : 0;
    const sum = kL[i]! + z + prev + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

// kR + zR modulo 2^256.
function add256(kR: Uint8Array, zR: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const sum = kR[i]! + zR[i]! + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

export function publicKeyOf(key: Bip32Key): Uint8Array {
  return Point.BASE.multiply(littleEndianToBigInt(key.subarray(0, 32)) % ORDER).toBytes();
}

export function deriveChild(parent: Bip32Key, index: number): Bip32Key {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`derivation index must be an integer from 0 to 2^32 - 1, got ${index}`);
  }
  if (parent.length !== 96) throw new Error('a BIP32-Ed25519 key must be 96 bytes');
  const kL = parent.subarray(0, 32);
  const kR = parent.subarray(32, 64);
  const chainCode = parent.subarray(64, 96);
  const idx = indexBytes(index);
  const hardened = index >= HARDENED;
  const data = hardened ? concat(kL, kR, idx) : concat(publicKeyOf(parent), idx);
  const z = hmac(sha512, chainCode, concat(Uint8Array.of(hardened ? 0x00 : 0x02), data));
  const c = hmac(sha512, chainCode, concat(Uint8Array.of(hardened ? 0x01 : 0x03), data));
  return concat(addMul8(kL, z.subarray(0, 28)), add256(kR, z.subarray(32, 64)), c.subarray(32, 64));
}

export function derivePath(root: Bip32Key, path: readonly number[]): Bip32Key {
  // Always a fresh array, also for an empty path, so callers never alias root.
  return path.reduce(deriveChild, root.slice());
}
