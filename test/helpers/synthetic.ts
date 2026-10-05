import { blake2b } from '@noble/hashes/blake2.js';
import { concat } from '../../src/core/bytes.js';
import type { TxInput } from '../../src/core/cbor/tx.js';
import { plutusScript } from './plutus-fixtures.js';

/** A 28 byte policy id shared by the native asset tests. */
export const POLICY = 'ab'.repeat(28);

/** Deterministic fake outpoint so tests read the same ids every run. */
export function syntheticInput(seed: string, index: bigint): TxInput {
  return { txId: blake2b(new TextEncoder().encode(seed), { dkLen: 32 }), index };
}

/** A 28 byte hash filled with one byte, for key hashes, script hashes and policy ids a test does not derive. */
export const hash28 = (n: number) => new Uint8Array(28).fill(n);

/** A testnet enterprise address locked by this script hash (header 0x70). */
export const scriptAddress = (hash: Uint8Array) => concat(Uint8Array.of(0x70), hash);

/** A compiled Plutus script as plutus.json carries it: a CBOR byte string around flat bytes. The tests only parse it. */
export const PLUTUS_COMPILED = '500100003232222533002494984d260011';

/** A Plutus V3 script as the witness set carries it (the byte string content): the aiken always_succeeds of test/fixtures/plutus, which accepts every purpose. */
export const PLUTUS_V3 = plutusScript('v3_always_succeeds').cborHex;

/**
 * The program \_ -> \_ -> () as a Plutus V3 script. It returns a lambda after
 * two arguments, Plutus V3 passes one and needs unit back (CIP-117), so a node
 * rejects every run of it. Kept for exactly that case.
 */
export const PLUTUS_V3_TWO_ARGS = plutusScript('v3_two_args').cborHex;
