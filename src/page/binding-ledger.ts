import { bytesToHex, hexToBytes } from '../core/bytes.js';
import type { TxInput } from '../core/cbor/tx.js';
import { ChwError, type ChwErrorCode, type Cip30Error } from '../core/errors.js';
import type { Ledger, Utxo } from '../core/ledger.js';
import type { ForeignUtxoConfig } from './config.js';
import { utxoFromConfig } from './utxo-config.js';

/** A host function the page calls with an operation name and a JSON argument. Playwright's exposeBinding provides it. */
export type LedgerBinding = (op: string, arg?: unknown) => Promise<unknown>;

/** What the host answers to submit. Errors travel as values, a thrown value loses its shape on the way into the page. chwError.message has no '<code>: ' prefix. */
export type SubmitAnswer = { txId: string } | { error: Cip30Error } | { chwError: { code: ChwErrorCode; message: string } };

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
    const answer = (await this.call('submit', bytesToHex(tx))) as SubmitAnswer;
    // Thrown here, in the page, so the dApp gets the plain CIP-30 object and a test the ChwError it knows.
    if ('error' in answer) throw answer.error;
    if ('chwError' in answer) throw new ChwError(answer.chwError.code, answer.chwError.message);
    return hexToBytes(answer.txId);
  }
}
