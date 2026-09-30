import { bytesToHex, hexToBytes } from '../core/bytes.js';
import type { TxInput } from '../core/cbor/tx.js';
import type { Ledger, Utxo } from '../core/ledger.js';
import type { ForeignUtxoConfig } from './config.js';
import { utxoFromConfig } from './utxo-config.js';

/** A host function the page calls with an operation name and a JSON argument. Playwright's exposeBinding provides it. */
export type LedgerBinding = (op: string, arg?: unknown) => Promise<unknown>;

/**
 * The page side of a ledger that lives in the host. Every call goes through
 * the binding as JSON, so the state outlives reloads, navigations and origin
 * changes. Loading a page only reads: WebKit runs an init script twice on the
 * first navigation.
 */
export class BindingLedger implements Ledger {
  constructor(private readonly call: LedgerBinding) {}

  async resolveInput(input: TxInput): Promise<Utxo | undefined> {
    const found = (await this.call('resolveInput', { txId: bytesToHex(input.txId), index: input.index.toString() })) as ForeignUtxoConfig | null;
    return found ? utxoFromConfig(found) : undefined;
  }

  async getWalletUtxos(): Promise<Utxo[]> {
    return ((await this.call('getWalletUtxos')) as ForeignUtxoConfig[]).map(utxoFromConfig);
  }

  async getStakeRegistered(): Promise<boolean> {
    return (await this.call('getStakeRegistered')) === true;
  }

  async submit(tx: Uint8Array): Promise<Uint8Array> {
    return hexToBytes((await this.call('submit', bytesToHex(tx))) as string);
  }
}
