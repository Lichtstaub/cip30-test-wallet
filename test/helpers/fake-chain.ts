// A chain for unit tests: a MemoryLedger holds what is confirmed, a list holds
// the mempool. Refusals and transport failures are scripted per call. Nothing
// reaches a network.
import { bytesEqual, bytesToHex, hexToBytes } from '../../src/core/bytes.js';
import { parseTransaction, txHash, type TxInput } from '../../src/core/cbor/tx.js';
import { ChwError } from '../../src/core/errors.js';
import { MemoryLedger, type Utxo, type WalletCredentials } from '../../src/core/ledger.js';
import type { ChainProvider, OgmiosError, SubmitResult } from '../../src/host/chain/provider.js';
import { buildTx, TEST_ADDRESS } from './build-tx.js';

export type FakeMethod = 'networkId' | 'utxosAt' | 'unspentOutputs' | 'stakeRegistered' | 'submit';

export interface FakeChainOptions {
  /** The wallet whose outputs and stake key the confirmed ledger tracks. */
  wallet: WalletCredentials;
  /** Confirmed outputs of the wallet at the start. */
  owned?: Utxo[];
  /** Confirmed outputs of others at the start. */
  foreign?: Utxo[];
  stakeRegistered?: boolean;
  /** What networkId() answers, 0 when left out. */
  networkId?: 0 | 1;
}

const outpoint = (input: TxInput) => `${bytesToHex(input.txId)}#${input.index}`;

/**
 * A ChainProvider over a MemoryLedger. submit puts a transaction into the
 * mempool, confirm() applies mempool transactions to the ledger in submit
 * order. Reads answer from the ledger only, like a node's ledger state query.
 */
export class FakeChain implements ChainProvider {
  readonly name = 'fake';
  readonly ledger: MemoryLedger;
  readonly calls: FakeMethod[] = [];
  private pool: Uint8Array[] = [];
  private readonly refusals: OgmiosError[] = [];
  private readonly failures = new Map<FakeMethod, number>();
  private readonly holds = new Map<FakeMethod, Array<{ arrived: () => void; gate: Promise<void> }>>();
  private readonly network: 0 | 1;
  private readonly stakeKeyHash: Uint8Array;

  constructor(opts: FakeChainOptions) {
    this.ledger = new MemoryLedger({ owned: opts.owned ?? [], foreign: opts.foreign ?? [], wallet: opts.wallet, stakeRegistered: opts.stakeRegistered ?? false });
    this.network = opts.networkId ?? 0;
    this.stakeKeyHash = opts.wallet.stakeKeyHash;
  }

  get mempool(): readonly Uint8Array[] {
    return this.pool;
  }

  refuseNext(error: OgmiosError): void {
    this.refusals.push(error);
  }

  failNext(method: FakeMethod, times = 1): void {
    this.failures.set(method, (this.failures.get(method) ?? 0) + times);
  }

  async confirm(count = Infinity): Promise<string[]> {
    const confirmed = this.pool.slice(0, count);
    this.pool = this.pool.slice(confirmed.length);
    for (const tx of confirmed) await this.ledger.submit(tx);
    return confirmed.map((tx) => bytesToHex(txHash(tx)));
  }

  async spendExternally(input: TxInput): Promise<string> {
    const tx = hexToBytes(buildTx({ inputs: [input], outputs: [{ address: TEST_ADDRESS, lovelace: 1_000_000n }], fee: 0n }));
    await this.ledger.submit(tx);
    // In submit order, so a transaction lost here takes every later one that spends its outputs along.
    const gone = new Set([outpoint(input)]);
    this.pool = this.pool.filter((bytes) => {
      const { body, hash, isValid } = parseTransaction(bytes);
      const consumed = isValid ? body.inputs : body.collateralInputs;
      if (!consumed.some((i) => gone.has(outpoint(i)))) return true;
      body.outputs.forEach((_, i) => gone.add(`${bytesToHex(hash)}#${i}`));
      return false;
    });
    return bytesToHex(txHash(tx));
  }

  /** The next call of this method reads its answer at once and returns it only after release(). reached resolves when that call came in. */
  hold(method: FakeMethod): { reached: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.holds.set(method, [...(this.holds.get(method) ?? []), { arrived, gate }]);
    return { reached, release };
  }

  /** Records the call, throws when a failure is scripted for it, reads the answer at once and returns it when no hold keeps it back. */
  private async answer<T>(method: FakeMethod, read: () => T | Promise<T>): Promise<T> {
    this.enter(method);
    const value = await read();
    const hold = this.holds.get(method)?.shift();
    if (hold) {
      hold.arrived();
      await hold.gate;
    }
    return value;
  }

  /** Records the call and throws when a failure is scripted for it. */
  private enter(method: FakeMethod): void {
    this.calls.push(method);
    const left = this.failures.get(method) ?? 0;
    if (left > 0) {
      this.failures.set(method, left - 1);
      throw new ChwError('CHW_CHAIN_UNAVAILABLE', `fake ${method} failed with HTTP 503`);
    }
  }

  networkId(): Promise<0 | 1> {
    return this.answer('networkId', () => this.network);
  }

  utxosAt(address: Uint8Array): Promise<Utxo[]> {
    return this.answer('utxosAt', async () => (await this.ledger.getWalletUtxos()).filter((u) => bytesEqual(u.address, address)));
  }

  unspentOutputs(inputs: readonly TxInput[]): Promise<Utxo[]> {
    return this.answer('unspentOutputs', () =>
      inputs.flatMap((input) => {
        const found = this.ledger.unspent(input);
        return found ? [found] : [];
      }),
    );
  }

  stakeRegistered(stakeKeyHash: Uint8Array): Promise<boolean> {
    return this.answer('stakeRegistered', async () => bytesEqual(stakeKeyHash, this.stakeKeyHash) && (await this.ledger.getStakeRegistered()));
  }

  submit(tx: Uint8Array): Promise<SubmitResult> {
    return this.answer('submit', (): SubmitResult => {
      const refusal = this.refusals.shift();
      if (refusal) return { ok: false, error: refusal };
      this.pool.push(tx);
      return { ok: true, txId: txHash(tx) };
    });
  }
}
