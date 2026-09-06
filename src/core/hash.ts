import { blake2b } from '@noble/hashes/blake2.js';

/** Blake2b-224 of a 32-byte public key, the credential hash used in addresses. */
export function keyHash(pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) throw new Error('public key must be 32 bytes');
  return blake2b(pub, { dkLen: 28 });
}
