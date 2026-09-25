// CIP-8 message signing as CIP-30 signData uses it. The byte layout follows
// Emurgo's message-signing library, which the tests pin: protected header
// {1: -8, "address": bstr} in this order, unprotected {"hashed": false},
// payload embedded and unhashed, an untagged COSE_Sign1, and an OKP Ed25519
// COSE_Key without kid. CIP-8 leaves map order open, so the order below is
// the compatibility contract.
import { decode, Tagged, type CborValue } from './cbor/decode.js';
import { encode } from './cbor/encode.js';
import { publicKey, sign, type SigningKey } from './keys.js';

const EDDSA = -8n;

export interface DecodedCoseSign1 {
  protectedBytes: Uint8Array;
  alg: bigint | undefined;
  address: Uint8Array | undefined;
  hashed: boolean;
  payload: Uint8Array;
  signature: Uint8Array;
}

export interface DecodedCoseKey {
  kty: bigint | undefined;
  alg: bigint | undefined;
  crv: bigint | undefined;
  x: Uint8Array;
}

export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  return encode(['Signature1', protectedBytes, new Uint8Array(0), payload]);
}

export function signCose(key: SigningKey, address: Uint8Array, payload: Uint8Array): { signature: Uint8Array; key: Uint8Array } {
  const protectedBytes = encode(new Map<CborValue, CborValue>([[1n, EDDSA], ['address', address]]));
  const signature = sign(key, sigStructure(protectedBytes, payload));
  const sign1 = encode([protectedBytes, new Map<CborValue, CborValue>([['hashed', false]]), payload, signature]);
  const coseKey = encode(new Map<CborValue, CborValue>([[1n, 1n], [3n, EDDSA], [-1n, 6n], [-2n, publicKey(key)]]));
  return { signature: sign1, key: coseKey };
}

export function decodeCoseSign1(bytes: Uint8Array): DecodedCoseSign1 {
  let value = decode(bytes);
  if (value instanceof Tagged && value.tag === 18n) value = value.value;
  if (!Array.isArray(value) || value.length !== 4) throw new Error('COSE_Sign1 must be a four element array');
  const [protectedBytes, unprotected, payload, signature] = value;
  if (!(protectedBytes instanceof Uint8Array)) throw new Error('COSE_Sign1 protected header must be a byte string');
  if (!(payload instanceof Uint8Array)) throw new Error('COSE_Sign1 payload must be embedded, detached payloads are not supported');
  if (!(signature instanceof Uint8Array)) throw new Error('COSE_Sign1 signature must be a byte string');
  const headers = protectedBytes.length === 0 ? new Map<CborValue, CborValue>() : decode(protectedBytes);
  if (!(headers instanceof Map)) throw new Error('COSE_Sign1 protected header must encode a map');
  if (!(unprotected instanceof Map)) throw new Error('COSE_Sign1 unprotected header must be a map');
  // has(), not a check for undefined: the decoder maps CBOR undefined (f7) to undefined as well.
  const hashedValue = unprotected.get('hashed');
  if (unprotected.has('hashed') && typeof hashedValue !== 'boolean') throw new Error('COSE_Sign1 hashed header must be a boolean');
  const alg = headers.get(1n);
  const address = headers.get('address');
  const hashed = hashedValue === true;
  return {
    protectedBytes,
    alg: typeof alg === 'bigint' ? alg : undefined,
    address: address instanceof Uint8Array ? address : undefined,
    hashed,
    payload,
    signature,
  };
}

export function decodeCoseKey(bytes: Uint8Array): DecodedCoseKey {
  const value = decode(bytes);
  if (!(value instanceof Map)) throw new Error('COSE_Key must be a map');
  const x = value.get(-2n);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error('COSE_Key x must be a 32 byte public key');
  const int = (label: bigint) => {
    const v = value.get(label);
    return typeof v === 'bigint' ? v : undefined;
  };
  return { kty: int(1n), alg: int(3n), crv: int(-1n), x };
}
