import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { txHash, type TxInput } from '../src/core/cbor/tx.js';
import { ChwError, TxSendErrorCode } from '../src/core/errors.js';
import { keyHash } from '../src/core/hash.js';
import type { Utxo, WalletCredentials } from '../src/core/ledger.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { ChainLedger } from '../src/host/chain/chain-ledger.js';
import { prepareWallet } from '../src/host/config.js';
import { LEDGER_BINDING } from '../src/host/ledger.js';
import { installWallet } from '../src/page/install.js';
import { buildTx, spliceWitnessSet, TEST_ADDRESS, witnessVkeys } from './helpers/build-tx.js';
import { FakeChain } from './helpers/fake-chain.js';
import { enableChw, pageWith, rejectionOf } from './helpers/page.js';
import { syntheticInput } from './helpers/synthetic.js';

/** A page wallet whose host ledger is a ChainLedger on a fake chain holding 10 ADA at the wallet's base address. */
async function setup() {
  const w = prepareWallet({ utxos: [] });
  const address = parseAddressArg(w.addresses.payment);
  const wallet: WalletCredentials = { paymentKeyHash: keyHash(hexToBytes(w.paymentPublicKeyHex)), stakeKeyHash: keyHash(hexToBytes(w.stakePublicKeyHex)), networkId: 0 };
  const u0: Utxo = { input: syntheticInput('chain-binding', 0n), address, lovelace: 10_000_000n };
  const chain = new FakeChain({ wallet, owned: [u0] });
  const page = pageWith(new ChainLedger({ provider: chain, baseAddress: address, wallet }));
  installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
  return { w, address, u0, chain, api: await enableChw(page) };
}

const spend = (inputs: TxInput[], outputs: Array<[Uint8Array, bigint]>) => buildTx({ inputs, outputs: outputs.map(([address, lovelace]) => ({ address, lovelace })), fee: 200_000n });

describe('a page wallet on a chain ledger', () => {
  it('reads the pending change, signs a follow-up against it and submits it before the chain confirms the first', async () => {
    const { w, address, u0, chain, api } = await setup();
    expect(await api.getUtxos()).toHaveLength(1);

    const tx1 = spend([u0.input], [[TEST_ADDRESS, 3_000_000n], [address, 6_800_000n]]);
    const id1 = await api.submitTx(spliceWitnessSet(tx1, await api.signTx(tx1, false)));
    expect(id1).toBe(bytesToHex(txHash(hexToBytes(tx1))));
    const afterFirst = (await api.getUtxos())!;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toContain(id1);

    // The change exists only in the mempool, signTx resolves it through the overlay.
    const tx2 = spend([{ txId: hexToBytes(id1), index: 1n }], [[address, 6_600_000n]]);
    const witnesses = await api.signTx(tx2, false);
    expect(witnessVkeys(witnesses)).toEqual([w.paymentPublicKeyHex]);
    const id2 = await api.submitTx(spliceWitnessSet(tx2, witnesses));
    expect(chain.mempool).toHaveLength(2);

    await chain.confirm();
    const confirmed = (await api.getUtxos())!;
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain(id2);
  });

  it('a chain refusal reaches the dApp as the plain TxSendError Failure with the rule name', async () => {
    const { u0, chain, api } = await setup();
    chain.refuseNext({
      code: 3997,
      message: "The transaction couldn't be added to the mempool. A justification is given as 'data.error'.",
      data: { error: 'All inputs are spent. Transaction has probably already been included' },
    });
    const tx = spend([u0.input], [[TEST_ADDRESS, 9_800_000n]]);
    const e = await rejectionOf(api.submitTx(spliceWitnessSet(tx, await api.signTx(tx, false))));
    expect(e).toEqual({ code: TxSendErrorCode.Failure, info: 'ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]' });
    expect(e).not.toBeInstanceOf(Error);
  });

  it('a transport failure on submit reaches the page as ChwError CHW_CHAIN_UNAVAILABLE', async () => {
    const { u0, chain, api } = await setup();
    chain.failNext('submit');
    const e = await rejectionOf(api.submitTx(spend([u0.input], [[TEST_ADDRESS, 9_800_000n]])));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: fake submit failed with HTTP 503' });
    expect(chain.mempool).toHaveLength(0);
  });

  it('a transport failure on a read reaches the page as ChwError CHW_CHAIN_UNAVAILABLE with its code, the next call works', async () => {
    const { chain, api } = await setup();
    chain.failNext('utxosAt');
    const e = await rejectionOf(api.getUtxos());
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: fake utxosAt failed with HTTP 503' });
    expect(await api.getUtxos()).toHaveLength(1);
  });

  it('a transport failure while signTx resolves an input reaches the page with its code as well', async () => {
    const { chain, api } = await setup();
    // An outpoint the ledger has not seen, so resolveInput asks the provider.
    chain.failNext('unspentOutputs');
    const e = await rejectionOf(api.signTx(spend([syntheticInput('chain-binding-foreign', 0n)], [[TEST_ADDRESS, 1_000_000n]]), false));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: fake unspentOutputs failed with HTTP 503' });
  });
});
