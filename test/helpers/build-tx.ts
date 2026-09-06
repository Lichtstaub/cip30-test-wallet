// Builds a minimal Conway transaction with our own encoder. Evolution must be
// able to parse the result, which the tests assert. Certificates are only
// stubbed as "present" to exercise the unsupported-field path.
//
// inputs and required_signers are Conway sets, CDDL nonempty_set<T> =
// #6.258([+T]) / [+T]. Evolution's own serializer always emits the tag 258
// form. When Transaction.addVKeyWitnessesHex merges a witness it re-encodes
// the whole transaction, so a plain array here would come back wrapped in
// tag 258, changing the body bytes and therefore the body hash a witness
// was signed over. Emitting tag 258 ourselves keeps a round trip through
// Evolution byte-for-byte stable.
import { encode } from '../../src/core/cbor/encode.js';
import { Tagged, type CborValue } from '../../src/core/cbor/decode.js';
import type { TxInput } from '../../src/core/cbor/tx.js';
import { bytesToHex, hexToBytes } from '../../src/core/bytes.js';
import { syntheticOwnedUtxo } from '../../src/page/install.js';

export interface BuildTxOptions {
  inputs: TxInput[];
  outputs: { address: Uint8Array; lovelace: bigint }[];
  fee: bigint;
  requiredSigners?: Uint8Array[];
  withdrawals?: { rewardAddress: Uint8Array; lovelace: bigint }[];
  certificatesPlaceholder?: boolean;
  /** Arbitrary extra body map entries, applied last so they can override the fields above. */
  extraBodyEntries?: Map<bigint, unknown>;
  /** Skip the tag 258 wrapping for inputs and required signers, emitting plain CDDL arrays instead. */
  plainArraySets?: boolean;
}

export function buildTx(opts: BuildTxOptions): string {
  const set = (items: CborValue[]) => (opts.plainArraySets ? items : new Tagged(258n, items));
  const body = new Map<bigint, unknown>();
  body.set(0n, set(opts.inputs.map((i) => [i.txId, i.index])));
  body.set(1n, opts.outputs.map((o) => [o.address, o.lovelace]));
  body.set(2n, opts.fee);
  if (opts.certificatesPlaceholder) {
    // A stake key registration certificate: [0, [0, key_hash]] with a dummy hash.
    body.set(4n, [[0n, [0n, new Uint8Array(28)]]]);
  }
  if (opts.withdrawals && opts.withdrawals.length > 0) {
    body.set(5n, new Map(opts.withdrawals.map((w) => [w.rewardAddress, w.lovelace])));
  }
  if (opts.requiredSigners && opts.requiredSigners.length > 0) {
    body.set(14n, set(opts.requiredSigners));
  }
  if (opts.extraBodyEntries) {
    for (const [key, value] of opts.extraBodyEntries) body.set(key, value);
  }
  const tx = [body, new Map(), true, null];
  return bytesToHex(encode(tx as never));
}

/** A synthetic address used across tests that need one but do not care which. */
export const TEST_ADDRESS = hexToBytes('00' + '11'.repeat(28) + '22'.repeat(28));

/** Spend synthetic utxo 0 of the named wallet, pay 9.8 ADA back, 0.2 ADA fee: the shape most signTx and submitTx tests need. */
export function standardUnsignedTx(walletName: string, address: Uint8Array = TEST_ADDRESS): string {
  const utxo = syntheticOwnedUtxo(walletName, 0, address, 10_000_000n);
  return buildTx({ inputs: [utxo.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
}
