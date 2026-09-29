import { blake2b } from '@noble/hashes/blake2.js';
import type { TxInput } from '../../src/core/cbor/tx.js';

/** A 28 byte policy id shared by the native asset tests. */
export const POLICY = 'ab'.repeat(28);

/** Deterministic fake outpoint so tests read the same ids every run. */
export function syntheticInput(seed: string, index: bigint): TxInput {
  return { txId: blake2b(new TextEncoder().encode(seed), { dkLen: 32 }), index };
}
