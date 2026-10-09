import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseAddressBytes, enterpriseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { outpoint, txHash, type TxInput } from '../src/core/cbor/tx.js';
import { ChwError, TxSendErrorCode } from '../src/core/errors.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import type { Utxo, WalletCredentials } from '../src/core/ledger.js';
import { deriveAccount } from '../src/derive/index.js';
import { ChainLedger } from '../src/host/chain/chain-ledger.js';
import { rejectionInfo } from '../src/host/chain/ogmios-errors.js';
import type { OgmiosError } from '../src/host/chain/provider.js';
import { buildTx, TEST_ADDRESS } from './helpers/build-tx.js';
import { FakeChain, type FakeChainOptions } from './helpers/fake-chain.js';
import { rejectionOf } from './helpers/page.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

afterEach(() => vi.restoreAllMocks());

const me = deriveAccount(MNEMONIC);
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const wallet: WalletCredentials = { paymentKeyHash: myPay, stakeKeyHash: myStake, networkId: 0 };
const myAddress = baseAddressBytes(0, myPay, myStake);
/** Someone else's address, outputs there are foreign. */
const ELSEWHERE = TEST_ADDRESS;

const mine = (seed: string, lovelace = 10_000_000n): Utxo => ({ input: syntheticInput(seed, 0n), address: myAddress, lovelace });
const keys = (utxos: Utxo[]) => utxos.map((u) => outpoint(u.input));
const idOf = (tx: Uint8Array) => bytesToHex(txHash(tx));
const output = (tx: Uint8Array, index: bigint): TxInput => ({ txId: txHash(tx), index });

/** Spends these inputs into these outputs with 0.2 ADA fee. The fake chain checks no balance. */
function pay(inputs: TxInput[], outputs: Array<[Uint8Array, bigint]>, extra?: Map<bigint, unknown>): Uint8Array {
  return hexToBytes(buildTx({ inputs, outputs: outputs.map(([address, lovelace]) => ({ address, lovelace })), fee: 200_000n, ...(extra ? { extraBodyEntries: extra } : {}) }));
}

function setup(opts: Omit<FakeChainOptions, 'wallet'> = {}) {
  const chain = new FakeChain({ wallet, ...opts });
  const ledger = new ChainLedger({ provider: chain, baseAddress: myAddress, wallet });
  return { chain, ledger };
}

// Ogmios 7.0.0 on node 11.0.1, submitTransaction of a transaction whose inputs were spent.
const ALL_INPUTS_SPENT: OgmiosError = {
  code: 3997,
  message: "The transaction couldn't be added to the mempool. A justification is given as 'data.error'.",
  data: { error: 'All inputs are spent. Transaction has probably already been included' },
};
const ALL_INPUTS_SPENT_INFO = 'ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]';

describe('ChainLedger reads', () => {
  it('shows the outputs at the base address and the registration as the provider has them', async () => {
    const a = mine('cl-a');
    const b = mine('cl-b', 5_000_000n);
    // Same payment key, enterprise address: the provider is asked for the base address only.
    const enterprise: Utxo = { input: syntheticInput('cl-enterprise', 0n), address: enterpriseAddressBytes(0, myPay), lovelace: 3_000_000n };
    const { ledger } = setup({ owned: [a, b, enterprise], stakeRegistered: true });
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a, b]));
    expect(await ledger.getStakeRegistered()).toBe(true);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('asks the provider once for the inputs of all pending transactions, and not at all without one', async () => {
    const a = mine('cl-calls-a');
    const b = mine('cl-calls-b');
    const { chain, ledger } = setup({ owned: [a, b] });
    await ledger.getWalletUtxos();
    expect(chain.calls).toEqual(['utxosAt']);
    await ledger.submit(pay([a.input], [[myAddress, 9_800_000n]]));
    await ledger.submit(pay([b.input], [[myAddress, 9_800_000n]]));
    chain.calls.length = 0;
    await ledger.getWalletUtxos();
    expect(chain.calls).toEqual(['unspentOutputs', 'utxosAt']);
  });
});

describe('the pending overlay', () => {
  it('shows the change of a submitted transaction before the chain confirms it, and once after', async () => {
    const a = mine('cl-change');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[ELSEWHERE, 3_000_000n], [myAddress, 6_800_000n]]);
    expect(bytesToHex(await ledger.submit(tx1))).toBe(idOf(tx1));
    expect(chain.mempool).toHaveLength(1);
    expect(keys(await chain.ledger.getWalletUtxos())).toEqual(keys([a]));
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 1n))]);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1)]);

    expect(await chain.confirm()).toEqual([idOf(tx1)]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 1n))]);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('keeps a follow-up that spends the pending change as long as its parent stays, in submit order', async () => {
    const a = mine('cl-follow-up');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[ELSEWHERE, 3_000_000n], [myAddress, 6_800_000n]]);
    await ledger.submit(tx1);
    expect((await ledger.resolveInput(output(tx1, 1n)))?.lovelace).toBe(6_800_000n);
    const tx2 = pay([output(tx1, 1n)], [[myAddress, 6_600_000n]]);
    await ledger.submit(tx2);
    // The provider knows no output of tx1, tx2 stays because tx1 stays.
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1), idOf(tx2)]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx2, 0n))]);

    await chain.confirm(1);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx2)]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx2, 0n))]);

    await chain.confirm();
    expect(await ledger.pendingTxIds()).toEqual([]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx2, 0n))]);
  });

  it('shows every output once when the chain confirms between the pending check and the snapshot', async () => {
    const a = mine('cl-between');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    await ledger.submit(tx1);
    const unspentOutputs = chain.unspentOutputs.bind(chain);
    vi.spyOn(chain, 'unspentOutputs').mockImplementationOnce(async (inputs) => {
      const answer = await unspentOutputs(inputs);
      await chain.confirm();
      return answer;
    });
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 0n))]);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('runs overlapping reads one after the other, so a confirmation between them never brings a spent input back', async () => {
    const a = mine('cl-overlap');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    await ledger.submit(tx1);
    chain.calls.length = 0;
    // The first read takes its snapshot while a is unspent and holds the answer back.
    const held = chain.hold('utxosAt');
    const first = ledger.getWalletUtxos();
    await held.reached;
    await chain.confirm();
    const second = ledger.getWalletUtxos();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second read waits for the first and has not asked the provider yet.
    expect(chain.calls).toEqual(['unspentOutputs', 'utxosAt']);
    held.release();
    // The first read applies tx1 to its old snapshot, the second sees the block. Both show the change only.
    expect(keys(await first)).toEqual([outpoint(output(tx1, 0n))]);
    expect(keys(await second)).toEqual([outpoint(output(tx1, 0n))]);
    expect(chain.calls).toEqual(['unspentOutputs', 'utxosAt', 'unspentOutputs', 'utxosAt']);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('drops a pending transaction whose input someone else spent, with its change and every follow-up built on it', async () => {
    const a = mine('cl-competitor-a');
    const b = mine('cl-competitor-b', 4_000_000n);
    const { chain, ledger } = setup({ owned: [a, b] });
    const tx1 = pay([a.input], [[ELSEWHERE, 3_000_000n], [myAddress, 6_800_000n]]);
    const tx2 = pay([output(tx1, 1n)], [[myAddress, 6_600_000n]]);
    await ledger.submit(tx1);
    await ledger.submit(tx2);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(b.input), outpoint(output(tx2, 0n))]);

    await chain.spendExternally(a.input);
    expect(chain.mempool).toHaveLength(0);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(b.input)]);
    expect(await ledger.pendingTxIds()).toEqual([]);
    // Nothing comes back with the next block.
    await chain.confirm();
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(b.input)]);
  });

  it('a transaction with is_valid false takes only its collateral and adds only the collateral return', async () => {
    const a = mine('cl-invalid-input');
    const c = mine('cl-invalid-collateral', 5_000_000n);
    const { chain, ledger } = setup({ owned: [a, c] });
    const tx = hexToBytes(
      buildTx({
        inputs: [a.input],
        outputs: [
          { address: ELSEWHERE, lovelace: 1_000_000n },
          { address: ELSEWHERE, lovelace: 2_000_000n },
        ],
        fee: 200_000n,
        isValid: false,
        extraBodyEntries: new Map<bigint, unknown>([
          [13n, new Tagged(258n, [[c.input.txId, c.input.index]])],
          [16n, [myAddress, 4_500_000n]],
        ]),
      }),
    );
    await ledger.submit(tx);
    // The collateral return sits at index 2, the number of outputs.
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(a.input), outpoint(output(tx, 2n))]);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx)]);

    await chain.confirm();
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(a.input), outpoint(output(tx, 2n))]);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('a stake registration in a pending transaction counts before the chain confirms it', async () => {
    const a = mine('cl-stake');
    const { chain, ledger } = setup({ owned: [a] });
    expect(await ledger.getStakeRegistered()).toBe(false);
    await ledger.submit(pay([a.input], [[myAddress, 7_800_000n]], new Map([[4n, [[7n, [0n, myStake], 2_000_000n]]]])));
    expect(await ledger.getStakeRegistered()).toBe(true);
    expect(await chain.ledger.getStakeRegistered()).toBe(false);

    await chain.confirm();
    expect(await ledger.getStakeRegistered()).toBe(true);
    expect(await ledger.pendingTxIds()).toEqual([]);
  });
});

describe('a provider that fails', () => {
  it('fails a read with CHW_CHAIN_UNAVAILABLE naming provider and method, keeps the overlay, and the next read works', async () => {
    const a = mine('cl-down');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    await ledger.submit(tx1);
    const reads = [
      ['unspentOutputs', () => ledger.getWalletUtxos()],
      ['utxosAt', () => ledger.getWalletUtxos()],
      ['stakeRegistered', () => ledger.getStakeRegistered()],
    ] as const;
    for (const [method, read] of reads) {
      chain.failNext(method);
      const e = await rejectionOf(read());
      expect(e).toBeInstanceOf(ChwError);
      expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: `CHW_CHAIN_UNAVAILABLE: fake ${method} failed with HTTP 503` });
    }
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1)]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 0n))]);
  });

  it('fails resolveInput of an outpoint it has not seen the same way, the next call works', async () => {
    const foreign: Utxo = { input: syntheticInput('cl-resolve-down', 2n), address: ELSEWHERE, lovelace: 2_000_000n };
    const { chain, ledger } = setup({ foreign: [foreign] });
    chain.failNext('unspentOutputs');
    await expect(ledger.resolveInput(foreign.input)).rejects.toThrow('CHW_CHAIN_UNAVAILABLE: fake unspentOutputs failed with HTTP 503');
    expect(await ledger.resolveInput(foreign.input)).toEqual(foreign);
  });

  it('a submit that times out after the node took the transaction stays out of the overlay, a read after the block shows it', async () => {
    const a = mine('cl-submit-timeout');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    const submit = chain.submit.bind(chain);
    vi.spyOn(chain, 'submit').mockImplementationOnce(async (tx) => {
      await submit(tx);
      throw new ChwError('CHW_CHAIN_UNAVAILABLE', 'fake submitTransaction failed: no answer within 30 s');
    });
    await expect(ledger.submit(tx1)).rejects.toThrow('CHW_CHAIN_UNAVAILABLE: fake submitTransaction failed: no answer within 30 s');
    expect(chain.mempool).toHaveLength(1);
    expect(await ledger.pendingTxIds()).toEqual([]);
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));
    await chain.confirm();
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 0n))]);
  });

  it('a submit that fails in transport changes neither overlay nor mempool, the same transaction goes through afterwards', async () => {
    const a = mine('cl-submit-down');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    chain.failNext('submit');
    const e = await rejectionOf(ledger.submit(tx1));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: fake submit failed with HTTP 503' });
    expect(chain.mempool).toHaveLength(0);
    expect(await ledger.pendingTxIds()).toEqual([]);
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));

    await ledger.submit(tx1);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1)]);
  });
});

describe('resolveInput', () => {
  it('resolves an own output a pending transaction consumed, also after the chain confirmed the spend', async () => {
    const a = mine('cl-resolve-spent');
    const { chain, ledger } = setup({ owned: [a] });
    await ledger.getWalletUtxos();
    await ledger.submit(pay([a.input], [[myAddress, 9_800_000n]]));
    expect(await ledger.resolveInput(a.input)).toEqual(a);
    await chain.confirm();
    expect(chain.ledger.unspent(a.input)).toBeUndefined();
    expect(await ledger.resolveInput(a.input)).toEqual(a);
  });

  it('resolves an output it read in a snapshot after someone else spent it, without asking the provider', async () => {
    const a = mine('cl-resolve-snapshot');
    const { chain, ledger } = setup({ owned: [a] });
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));
    await chain.spendExternally(a.input);
    chain.calls.length = 0;
    expect(await ledger.resolveInput(a.input)).toEqual(a);
    expect(chain.calls).toEqual([]);
  });

  it('resolves outputs of a pending transaction from the overlay without asking the provider', async () => {
    const a = mine('cl-resolve-overlay');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[ELSEWHERE, 3_000_000n], [myAddress, 6_800_000n]]);
    await ledger.submit(tx1);
    chain.calls.length = 0;
    expect(await ledger.resolveInput(output(tx1, 0n))).toEqual({ input: output(tx1, 0n), address: ELSEWHERE, lovelace: 3_000_000n });
    expect(chain.calls).toEqual([]);
  });

  it('asks the provider for an outpoint it has not seen and remembers the answer, an unknown one stays unknown', async () => {
    const foreign: Utxo = { input: syntheticInput('cl-resolve-foreign', 1n), address: ELSEWHERE, lovelace: 2_000_000n };
    const { chain, ledger } = setup({ foreign: [foreign] });
    expect(await ledger.resolveInput(foreign.input)).toEqual(foreign);
    expect(await ledger.resolveInput(foreign.input)).toEqual(foreign);
    expect(chain.calls).toEqual(['unspentOutputs']);
    expect(await ledger.resolveInput(syntheticInput('cl-nowhere', 0n))).toBeUndefined();
  });
});

describe('ChainLedger submit', () => {
  it('a refusal is TxSendError Failure with the rule name and changes nothing', async () => {
    const a = mine('cl-refused');
    const { chain, ledger } = setup({ owned: [a] });
    chain.refuseNext(ALL_INPUTS_SPENT);
    const e = await rejectionOf(ledger.submit(pay([a.input], [[myAddress, 9_800_000n]])));
    expect(e).toEqual({ code: TxSendErrorCode.Failure, info: ALL_INPUTS_SPENT_INFO });
    expect(e).not.toBeInstanceOf(Error);
    expect(chain.mempool).toHaveLength(0);
    expect(await ledger.pendingTxIds()).toEqual([]);
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));
  });

  it('turns every refusal into its info with rejectionInfo, an unknown code as Ogmios code and message', async () => {
    const a = mine('cl-refusals');
    const { chain, ledger } = setup({ owned: [a] });
    const tx = pay([a.input], [[myAddress, 9_800_000n]]);
    chain.refuseNext({ code: 4242, message: 'something new' });
    expect(await rejectionOf(ledger.submit(tx))).toEqual({ code: TxSendErrorCode.Failure, info: 'Ogmios 4242: something new' });
    // Ogmios 7.0.0 on node 11.0.1, submitTransaction with a fee of 1000 lovelace.
    const feeTooSmall: OgmiosError = {
      code: 3122,
      message:
        "Insufficient fee! The transaction doesn't not contain enough fee to cover the minimum required by the protocol. Note that fee depends on (a) a flat cost fixed by the protocol, (b) the size of the serialized transaction, (c) the budget allocated for Plutus script execution. The field 'data.minimumRequiredFee' indicates the minimum required fee whereas 'data.providedFee' refers to the fee currently supplied with the transaction.",
      data: { minimumRequiredFee: { ada: { lovelace: 165149 } }, providedFee: { ada: { lovelace: 1000 } } },
    };
    chain.refuseNext(feeTooSmall);
    expect(await rejectionOf(ledger.submit(tx))).toEqual({ code: TxSendErrorCode.Failure, info: rejectionInfo(feeTooSmall) });
    expect(await ledger.pendingTxIds()).toEqual([]);
  });

  it('sends one submit at a time in the order they came, a refused one does not stop the next', async () => {
    const a = mine('cl-queue-a');
    const b = mine('cl-queue-b');
    const { chain, ledger } = setup({ owned: [a, b] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    const tx2 = pay([b.input], [[myAddress, 9_800_000n]]);
    const submit = chain.submit.bind(chain);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const reached: string[] = [];
    vi.spyOn(chain, 'submit').mockImplementation(async (tx) => {
      reached.push(idOf(tx));
      if (reached.length === 1) await gate;
      return submit(tx);
    });
    chain.refuseNext(ALL_INPUTS_SPENT);
    const first = rejectionOf(ledger.submit(tx1));
    const second = ledger.submit(tx2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reached).toEqual([idOf(tx1)]);
    open();
    expect(await first).toEqual({ code: TxSendErrorCode.Failure, info: ALL_INPUTS_SPENT_INFO });
    expect(bytesToHex(await second)).toBe(idOf(tx2));
    expect(reached).toEqual([idOf(tx1), idOf(tx2)]);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx2)]);
  });

  it('a provider answering another tx id is CHW_CHAIN_UNAVAILABLE and leaves the overlay as it was', async () => {
    const a = mine('cl-mismatch');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    vi.spyOn(chain, 'submit').mockResolvedValueOnce({ ok: true, txId: new Uint8Array(32) });
    const e = await rejectionOf(ledger.submit(tx1));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({
      code: 'CHW_CHAIN_UNAVAILABLE',
      message: `CHW_CHAIN_UNAVAILABLE: fake submit answered the transaction id ${'00'.repeat(32)}, the transaction has the id ${idOf(tx1)}`,
    });
    expect(await ledger.pendingTxIds()).toEqual([]);
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));
  });

  it('a transaction that does not parse never reaches the provider, the queue goes on', async () => {
    const a = mine('cl-garbage');
    const { chain, ledger } = setup({ owned: [a] });
    await expect(ledger.submit(Uint8Array.of(0x82, 0x00, 0x00))).rejects.toThrow('not a transaction: expected a CBOR array of 4 items');
    expect(chain.calls).toEqual([]);
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    await ledger.submit(tx1);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1)]);
  });

  it('a second submit of the same transaction goes to the provider again and changes the overlay once', async () => {
    const a = mine('cl-twice');
    const { chain, ledger } = setup({ owned: [a] });
    const tx1 = pay([a.input], [[myAddress, 9_800_000n]]);
    await ledger.submit(tx1);
    await ledger.submit(tx1);
    expect(chain.calls.filter((m) => m === 'submit')).toHaveLength(2);
    expect(await ledger.pendingTxIds()).toEqual([idOf(tx1)]);
    expect(keys(await ledger.getWalletUtxos())).toEqual([outpoint(output(tx1, 0n))]);
  });
});
