import type { TxInput } from '../../core/cbor/tx.js';
import { apiError, APIErrorCode, ChwError, TxSendErrorCode, txSendError } from '../../core/errors.js';
import type { Ledger, MemoryLedger, Utxo } from '../../core/ledger.js';
import type { LedgerChecksConfig } from '../config.js';
import { applyCertificates, initialCertState, type CertState } from './cert-state.js';
import { buildCheckContext } from './context.js';
import { formatFailures } from './failure.js';
import { checkTransaction } from './index.js';

export interface CheckedLedgerOptions {
  checks: LedgerChecksConfig;
  networkId: 0 | 1;
  stakeKeyHash: Uint8Array;
  drepKeyHash: Uint8Array;
  stakeRegistered: boolean;
}

/** A reader failure is the dApp's malformed transaction, reported like the page parser reports one. */
function readOrRefuse<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw apiError(APIErrorCode.InvalidRequest, error instanceof Error ? error.message : 'tx could not be decoded');
  }
}

/**
 * The wallet's ledger with the node's checks in front of it. A transaction a
 * Conway node would refuse is refused as TxSendError Failure naming the
 * node's rules and changes nothing. Only an accepted transaction reaches the
 * inner ledger. The certificate state with its deposits lives here, the
 * inner ledger keeps stakeRegistered for CIP-95. Both apply the same
 * certificates, and only those of a valid transaction.
 */
export class CheckedLedger implements Ledger {
  private state: CertState;
  /** The submit before this one, settled or not. Never rejects, errors go to the caller of submit. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly inner: MemoryLedger,
    private readonly opts: CheckedLedgerOptions,
  ) {
    this.state = initialCertState({
      stakeKeyHash: opts.stakeKeyHash,
      stakeRegistered: opts.stakeRegistered,
      drepKeyHash: opts.drepKeyHash,
      drepRegistered: opts.checks.drepRegistered,
      params: opts.checks.params,
    });
  }

  get certState(): CertState {
    return this.state;
  }

  resolveInput(input: TxInput): Promise<Utxo | undefined> {
    return this.inner.resolveInput(input);
  }

  getWalletUtxos(): Promise<Utxo[]> {
    return this.inner.getWalletUtxos();
  }

  getStakeRegistered(): Promise<boolean> {
    return this.inner.getStakeRegistered();
  }

  /**
   * One submit at a time, in the order they came. inner.submit changes the UTxOs at once and the
   * certificate state follows after its await, so a second submit started in between would be
   * checked against the certificate state before the first. A refused submit does not stop the next.
   */
  submit(tx: Uint8Array): Promise<Uint8Array> {
    const run = this.queue.then(() => this.checkAndSubmit(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async checkAndSubmit(tx: Uint8Array): Promise<Uint8Array> {
    const { checks, networkId } = this.opts;
    const ctx = readOrRefuse(() =>
      // A spent output counts as unknown, a node no longer holds it. signTx still resolves it through resolveInput.
      buildCheckContext(tx, (input) => this.inner.unspent(input), { params: checks.params, networkId, currentSlot: checks.currentSlot, certState: this.state }),
    );
    const { failures, unsupported } = checkTransaction(ctx);
    if (unsupported.length > 0) {
      throw new ChwError(
        'CHW_UNSUPPORTED_TX_FORM',
        `the ledger checks cannot judge ${unsupported.join(', ')}. Submit this transaction in a test without walletOptions.ledger.checks`,
      );
    }
    if (failures.length > 0) throw txSendError(TxSendErrorCode.Failure, formatFailures(failures));
    const id = await this.inner.submit(tx);
    if (ctx.parsed.isValid) this.state = applyCertificates(this.state, ctx.facts, checks.params);
    return id;
  }
}
