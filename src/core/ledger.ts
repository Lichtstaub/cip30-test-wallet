import { bytesEqual } from './bytes.js';
import { encode } from './cbor/encode.js';
import { txHash, type TxInput } from './cbor/tx.js';

export interface Utxo {
  input: TxInput;
  address: Uint8Array;
  lovelace: bigint;
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
 * transaction_unspent_output = [transaction_input, transaction_output]
 * The output uses the legacy array form [address, coin], which every
 * CIP-30 consumer accepts. Assets come with milestone 2.
 */
export function encodeUtxo(u: Utxo): Uint8Array {
  return encode([[u.input.txId, u.input.index], [u.address, u.lovelace]] as never);
}
