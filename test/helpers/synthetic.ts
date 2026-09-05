import { blake2b } from '@noble/hashes/blake2.js';
import type { TxInput } from '../../src/core/cbor/tx.js';

/** Deterministic fake outpoint so tests read the same ids every run. */
export function syntheticInput(seed: string, index: bigint): TxInput {
  return { txId: blake2b(new TextEncoder().encode(seed), { dkLen: 32 }), index };
}
