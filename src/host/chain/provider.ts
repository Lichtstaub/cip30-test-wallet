import type { TxInput } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';

/** What a chain answered to a submit. A refusal carries Ogmios' error object as it came, secrets of the connection redacted. */
export type SubmitResult = { ok: true; txId: Uint8Array } | { ok: false; error: OgmiosError };

/** The JSON-RPC error object of Ogmios: code, message and the optional data. */
export interface OgmiosError {
  code: number;
  message: string;
  data?: unknown;
}

/** The chain the ChainLedger reads and submits to. Every method throws ChwError CHW_CHAIN_UNAVAILABLE on transport failure. */
export interface ChainProvider {
  /** 'ogmios' or 'koios', for messages. */
  readonly name: string;
  /** 1 for mainnet, 0 for any test network. */
  networkId(): Promise<0 | 1>;
  /** Unspent outputs at this address. */
  utxosAt(address: Uint8Array): Promise<Utxo[]>;
  /** The unspent outputs among these outpoints, in any order. A spent or unknown outpoint is missing from the result. */
  unspentOutputs(inputs: readonly TxInput[]): Promise<Utxo[]>;
  /** Whether the stake key with this hash is registered now. */
  stakeRegistered(stakeKeyHash: Uint8Array): Promise<boolean>;
  /** Submits the exact bytes. */
  submit(tx: Uint8Array): Promise<SubmitResult>;
}
