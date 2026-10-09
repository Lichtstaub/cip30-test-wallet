import { bytesToHex, hexToBytes } from '../core/bytes.js';
import type { TxInput } from '../core/cbor/tx.js';
import { ChwError, type ChwErrorCode, type Cip30Error } from '../core/errors.js';
import type { Ledger, Utxo } from '../core/ledger.js';
import type { ForeignUtxoConfig } from './config.js';
import { utxoFromConfig } from './utxo-config.js';

/** A host function the page calls with an operation name and a JSON argument. Playwright's exposeBinding provides it. */
export type LedgerBinding = (op: string, arg?: unknown) => Promise<unknown>;

/**
 * What the host answers to every ledger operation. Errors travel as values: a value the host throws
 * reaches the page as a bare Error with name and message only. chwError.message has no '<code>: ' prefix.
 */
export type LedgerAnswer<T = unknown> = { value: T } | { error: Cip30Error } | { chwError: { code: ChwErrorCode; message: string } };

/**
 * The page side of a ledger that lives in the host. Every call goes through
 * the binding as JSON, so the state outlives reloads, navigations and origin
 * changes. Loading a page only reads: WebKit runs an init script twice on the
 * first navigation.
 */
export class BindingLedger implements Ledger {
  constructor(private readonly call: LedgerBinding) {}

  /** One operation through the binding. Errors are thrown here, in the page, so the dApp gets the plain CIP-30 object and a test the ChwError with its code. */
  private async ask(op: string, arg?: unknown): Promise<unknown> {
    const answer = (await this.call(op, arg)) as LedgerAnswer;
    if ('error' in answer) throw answer.error;
    if ('chwError' in answer) throw new ChwError(answer.chwError.code, answer.chwError.message);
    return answer.value;
  }

  async resolveInput(input: TxInput): Promise<Utxo | undefined> {
    const found = (await this.ask('resolveInput', { txId: bytesToHex(input.txId), index: input.index.toString() })) as ForeignUtxoConfig | null;
    return found ? utxoFromConfig(found) : undefined;
  }

  async getWalletUtxos(): Promise<Utxo[]> {
    return ((await this.ask('getWalletUtxos')) as ForeignUtxoConfig[]).map(utxoFromConfig);
  }

  async getStakeRegistered(): Promise<boolean> {
    return (await this.ask('getStakeRegistered')) === true;
  }

  async submit(tx: Uint8Array): Promise<Uint8Array> {
    return hexToBytes((await this.ask('submit', bytesToHex(tx))) as string);
  }
}
