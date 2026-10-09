import { bytesEqual, bytesToHex } from '../../core/bytes.js';
import { outpoint, parseTransaction, type ParsedTransaction, type TxInput } from '../../core/cbor/tx.js';
import { ChwError, TxSendErrorCode, txSendError } from '../../core/errors.js';
import { applyTransaction, type Ledger, type LedgerState, type Utxo, type WalletCredentials } from '../../core/ledger.js';
import { rejectionInfo } from './ogmios-errors.js';
import type { ChainProvider } from './provider.js';

export interface ChainLedgerOptions {
  provider: ChainProvider;
  /** The wallet's base address, the one owned UTxOs are queried at. */
  baseAddress: Uint8Array;
  wallet: WalletCredentials;
}

/** An own transaction the chain accepted and the overlay still applies. */
interface PendingTx {
  /** Transaction id in hex. */
  id: string;
  parsed: ParsedTransaction;
  /** What it takes from the ledger: its inputs, or its collateral inputs when is_valid is false. */
  consumed: TxInput[];
  /** What it creates, owned and foreign, with their outpoints. */
  created: Utxo[];
}

const EMPTY: LedgerState = { owned: [], foreign: [], spent: [], stakeRegistered: false };

/** The first output of every outpoint, in order. */
function unique(utxos: Utxo[]): Utxo[] {
  const seen = new Set<string>();
  return utxos.filter((u) => {
    const key = outpoint(u.input);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The wallet's ledger on a real chain. A read takes the provider's view and
 * applies every own transaction the chain accepted but does not show yet (the
 * pending overlay) with the same applyTransaction the memory ledger uses. So
 * a follow-up transaction sees the change of the one before it while both
 * wait in the mempool.
 *
 * Not handled: rollbacks, and a transaction the mempool drops while its
 * inputs stay unspent. It stays in the overlay as long as this ledger lives.
 * Public Koios may answer from several instances, so right after a confirmation
 * one read can still show a spent input or miss the change. The next read is
 * consistent again.
 */
export class ChainLedger implements Ledger {
  private pending: PendingTx[] = [];
  /** Every output this ledger has seen, by outpoint, spent ones included. An outpoint never changes its output. */
  private readonly seen = new Map<string, Utxo>();
  /** The read or submit before this one, settled or not. Never rejects, errors go to the caller. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ChainLedgerOptions) {}

  /**
   * Outputs of the overlay and every output seen before come from memory, so signTx also
   * resolves an input an own transaction already spent. Anything else comes from the
   * provider, which knows unspent outputs only.
   */
  async resolveInput(input: TxInput): Promise<Utxo | undefined> {
    const key = outpoint(input);
    const known = this.seen.get(key);
    if (known) return known;
    const found = (await this.opts.provider.unspentOutputs([input])).find((u) => outpoint(u.input) === key);
    if (found) this.remember([found]);
    return found;
  }

  getWalletUtxos(): Promise<Utxo[]> {
    return this.serial(async () => {
      await this.settle();
      const owned = await this.opts.provider.utxosAt(this.opts.baseAddress);
      this.remember(owned);
      return this.overlay({ ...EMPTY, owned }).owned;
    });
  }

  getStakeRegistered(): Promise<boolean> {
    return this.serial(async () => {
      await this.settle();
      const stakeRegistered = await this.opts.provider.stakeRegistered(this.opts.wallet.stakeKeyHash);
      return this.overlay({ ...EMPTY, stakeRegistered }).stakeRegistered;
    });
  }

  /** Transactions still in the overlay, oldest first, as tx ids in hex. */
  pendingTxIds(): Promise<string[]> {
    return this.serial(async () => {
      await this.settle();
      return this.pending.map((p) => p.id);
    });
  }

  submit(tx: Uint8Array): Promise<Uint8Array> {
    return this.serial(() => this.submitOne(tx));
  }

  /**
   * Reads and submits run one at a time, in the order they came. A read applies the overlay to the
   * snapshot it took after its own pending check, so no other read may drop a transaction from the
   * overlay in between, and a submit enters the overlay before the next call starts. A call that
   * fails does not stop the next.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submitOne(tx: Uint8Array): Promise<Uint8Array> {
    // Parsed first, so a transaction that does not parse never reaches the chain.
    const parsed = parseTransaction(tx);
    const { provider } = this.opts;
    const answer = await provider.submit(tx);
    if (!answer.ok) throw txSendError(TxSendErrorCode.Failure, rejectionInfo(answer.error));
    const id = bytesToHex(parsed.hash);
    if (!bytesEqual(answer.txId, parsed.hash)) {
      // The node took a transaction, but under another id than the one signed here. It stays out of
      // the overlay like a submit that timed out, a read after its block shows what the chain holds.
      throw new ChwError('CHW_CHAIN_UNAVAILABLE', `${provider.name} submit answered the transaction id ${bytesToHex(answer.txId)}, the transaction has the id ${id}`);
    }
    // A provider that accepts the same transaction twice changes the overlay once.
    if (!this.pending.some((p) => p.id === id)) {
      const made = applyTransaction(EMPTY, parsed, this.opts.wallet);
      const created = [...made.owned, ...made.foreign];
      this.remember(created);
      this.pending.push({ id, parsed, consumed: parsed.isValid ? parsed.body.inputs : parsed.body.collateralInputs, created });
    }
    return parsed.hash;
  }

  /**
   * Drops every pending transaction the provider's view already covers: one of the inputs it
   * consumes is neither unspent at the provider nor created by an earlier pending transaction
   * that stays. Then the transaction is in the ledger, or another one spent that input, and the
   * provider shows the right state either way. Outputs of a pending transaction exist only in
   * the mempool, the provider does not know them, so a follow-up that spends one stays as long
   * as its parent stays. One provider call for the inputs of all pending transactions. When the
   * provider fails nothing is dropped. Runs inside the queue, nothing else changes pending meanwhile.
   */
  private async settle(): Promise<void> {
    if (this.pending.length === 0) return;
    const inputs = new Map<string, TxInput>();
    for (const p of this.pending) for (const input of p.consumed) inputs.set(outpoint(input), input);
    const unspent = await this.opts.provider.unspentOutputs([...inputs.values()]);
    this.remember(unspent);
    const available = new Set(unspent.map((u) => outpoint(u.input)));
    const settled = new Set<string>();
    for (const p of this.pending) {
      if (p.consumed.every((input) => available.has(outpoint(input)))) {
        for (const u of p.created) available.add(outpoint(u.input));
      } else {
        settled.add(p.id);
      }
    }
    if (settled.size > 0) this.pending = this.pending.filter((p) => !settled.has(p.id));
  }

  /**
   * The snapshot with every pending transaction applied in submit order. settle runs before the
   * snapshot is read, so a transaction the chain confirms in between is applied on top of a
   * snapshot that holds its outputs already. The first output per outpoint shows them once.
   */
  private overlay(snapshot: LedgerState): LedgerState {
    let state = snapshot;
    for (const p of this.pending) state = applyTransaction(state, p.parsed, this.opts.wallet);
    return { ...state, owned: unique(state.owned), foreign: unique(state.foreign) };
  }

  private remember(utxos: readonly Utxo[]): void {
    for (const u of utxos) {
      const key = outpoint(u.input);
      if (!this.seen.has(key)) this.seen.set(key, u);
    }
  }
}
