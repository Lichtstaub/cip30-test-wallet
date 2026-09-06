import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concat } from './bytes.js';

// keyHash lives in hash.ts so address code can use it without pulling in the curve.
export { keyHash } from './hash.js';

// Two key shapes exist in Cardano:
//   seed:     32 bytes, standard Ed25519 (RFC 8032), the seed is hashed to get
//             scalar and nonce prefix.
//   extended: 64 bytes, BIP32-Ed25519 (Icarus, CIP-1852). The first 32 bytes
//             already are the clamped scalar, the last 32 are the nonce prefix.
//             Nothing is hashed before use. This is what every HD wallet holds.
// Signing an extended key with a standard Ed25519 function gives a different
// public key and a signature no wallet would produce, so the two paths are
// kept separate and both are tested against CSL.

export type SigningKey =
  | { kind: 'seed'; bytes: Uint8Array }
  | { kind: 'extended'; bytes: Uint8Array };

const Point = ed25519.Point;
const ORDER = Point.Fn.ORDER;

function assertSize(key: SigningKey): void {
  const want = key.kind === 'seed' ? 32 : 64;
  if (key.bytes.length !== want) throw new Error(`${key.kind} key must be ${want} bytes`);
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]!);
  return r;
}

function bigIntToLittleEndian32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function extendedScalar(key: Uint8Array): bigint {
  return littleEndianToBigInt(key.slice(0, 32)) % ORDER;
}

export function publicKey(key: SigningKey): Uint8Array {
  assertSize(key);
  if (key.kind === 'seed') return ed25519.getPublicKey(key.bytes);
  return Point.BASE.multiply(extendedScalar(key.bytes)).toBytes();
}

export function sign(key: SigningKey, message: Uint8Array): Uint8Array {
  assertSize(key);
  if (key.kind === 'seed') return ed25519.sign(message, key.bytes);
  const scalar = extendedScalar(key.bytes);
  const prefix = key.bytes.slice(32, 64);
  const A = Point.BASE.multiply(scalar).toBytes();
  const r = littleEndianToBigInt(sha512(concat(prefix, message))) % ORDER;
  const R = Point.BASE.multiply(r).toBytes();
  const k = littleEndianToBigInt(sha512(concat(R, A, message))) % ORDER;
  const S = (r + k * scalar) % ORDER;
  return concat(R, bigIntToLittleEndian32(S));
}

