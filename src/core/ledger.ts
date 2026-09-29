import { bytesEqual } from './bytes.js';
import { Tagged, type CborValue } from './cbor/decode.js';
import { encode } from './cbor/encode.js';
import { txHash, type TxInput } from './cbor/tx.js';
import { valueCbor, type MultiAsset } from './value.js';

export type Datum = { kind: 'hash'; hash: Uint8Array } | { kind: 'inline'; cbor: Uint8Array };

export interface Utxo {
  input: TxInput;
  address: Uint8Array;
  lovelace: bigint;
  assets?: MultiAsset;
  datum?: Datum;
  /** CBOR of script = [language tag, script bytes] */
  scriptRef?: Uint8Array;
}

/**
 * Everything signTx and the CIP-30 surface need from "the chain". In the
 * spike there is only the in-memory implementation. A chain provider
 * (Yaci, preprod, or similar) implements the same three async methods
 * later, before milestone 2 builds the CIP-30 surface against it.
 */
export interface Ledger {
  /** Any output this ledger knows, owned by the wallet or not. */
  resolveInput(input: TxInput): Promise<Utxo | undefined>;
  /** Outputs the wallet controls, in the order they were configured. */
  getWalletUtxos(): Promise<Utxo[]>;
  /** Record or broadcast a signed transaction, return its id (32 bytes). */
  submit(tx: Uint8Array): Promise<Uint8Array>;
}

function sameInput(a: TxInput, b: TxInput): boolean {
  return a.index === b.index && bytesEqual(a.txId, b.txId);
}

export class MemoryLedger implements Ledger {
  readonly submitted: Uint8Array[] = [];
  private readonly owned: Utxo[];
  private readonly foreign: Utxo[];

  constructor(opts: { owned: Utxo[]; foreign?: Utxo[] }) {
    this.owned = [...opts.owned];
    this.foreign = [...(opts.foreign ?? [])];
  }

  async resolveInput(input: TxInput): Promise<Utxo | undefined> {
    return [...this.owned, ...this.foreign].find((u) => sameInput(u.input, input));
  }

  async getWalletUtxos(): Promise<Utxo[]> {
    return [...this.owned];
  }

  async submit(tx: Uint8Array): Promise<Uint8Array> {
    // Hash first, so a transaction the hash rejects leaves no record behind.
    const id = txHash(tx);
    this.submitted.push(tx);
    return id;
  }
}

/**
 * The output the way cardano-js-sdk (Lace) writes it: the array form
 * [address, value] or [address, value, datum_hash] (Alonzo), the Babbage map
 * {0: address, 1: value, ?2: datum_option, ?3: script_ref} only when the
 * output carries an inline datum or a reference script. A coin-only output
 * stays [address, coin], byte-identical to earlier releases.
 */
export function encodeOutput(u: Utxo): CborValue {
  const value = valueCbor(u.lovelace, u.assets);
  if (u.datum?.kind === 'inline' || u.scriptRef) {
    const map = new Map<CborValue, CborValue>([
      [0n, u.address],
      [1n, value],
    ]);
    // datum_option = [0, hash32] / [1, #6.24(bytes .cbor plutus_data)]
    if (u.datum) map.set(2n, u.datum.kind === 'hash' ? [0n, u.datum.hash] : [1n, new Tagged(24n, u.datum.cbor)]);
    // script_ref = #6.24(bytes .cbor script)
    if (u.scriptRef) map.set(3n, new Tagged(24n, u.scriptRef));
    return map;
  }
  if (u.datum?.kind === 'hash') return [u.address, value, u.datum.hash];
  return [u.address, value];
}

/** transaction_unspent_output = [transaction_input, transaction_output] */
export function encodeUtxo(u: Utxo): Uint8Array {
  return encode([[u.input.txId, u.input.index], encodeOutput(u)] as never);
}
