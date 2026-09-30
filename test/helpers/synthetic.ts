import { blake2b } from '@noble/hashes/blake2.js';
import type { TxInput } from '../../src/core/cbor/tx.js';

/** A 28 byte policy id shared by the native asset tests. */
export const POLICY = 'ab'.repeat(28);

/** Deterministic fake outpoint so tests read the same ids every run. */
export function syntheticInput(seed: string, index: bigint): TxInput {
  return { txId: blake2b(new TextEncoder().encode(seed), { dkLen: 32 }), index };
}

/** A 28 byte hash filled with one byte, for key hashes, script hashes and policy ids a test does not derive. */
export const hash28 = (n: number) => new Uint8Array(28).fill(n);

/** A compiled Plutus script as plutus.json carries it: a CBOR byte string around flat bytes. Never executed. */
export const PLUTUS_COMPILED = '500100003232222533002494984d260011';

/** A Plutus V3 script as the witness set carries it (the byte string content). Never executed. */
export const PLUTUS_V3 = '4601000022499d';
