import { afterEach, describe, expect, it, vi } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { txHash } from '../src/core/cbor/tx.js';
import { APIErrorCode, apiError, ChwError, TxSendErrorCode, txSendError } from '../src/core/errors.js';
import type { MemoryLedger } from '../src/core/ledger.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { prepareWallet } from '../src/host/config.js';
import { LEDGER_BINDING, ledgerBinding, walletLedger } from '../src/host/ledger.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { utxoFromConfig, utxoToConfig } from '../src/page/utxo-config.js';
import { buildTx, spliceWitnessSet, standardUnsignedTx, TEST_ADDRESS } from './helpers/build-tx.js';
import { enableChw, pageWith, rejectionOf } from './helpers/page.js';
import { hash28 as h, syntheticInput } from './helpers/synthetic.js';

afterEach(() => vi.restoreAllMocks());

describe('JSON shape of ledger UTxOs', () => {
  it('round trips assets above 2^53, datum hash, inline datum and script ref', () => {
    const utxo = utxoFromConfig({
      txId: 'aa'.repeat(32),
      index: 3,
      addressHex: bytesToHex(TEST_ADDRESS),
      lovelace: '18446744073709551615',
      assets: { [bytesToHex(h(9)) + '41']: '1152921504606846976' },
      inlineDatum: 'd87980',
      scriptRef: '8203474601000022499d',
    });
    expect(utxoFromConfig(utxoToConfig(utxo))).toEqual(utxo);
    expect(utxoToConfig(utxo).assets).toEqual({ [bytesToHex(h(9)) + '41']: '1152921504606846976' });
    const hashed = utxoFromConfig({ txId: 'bb'.repeat(32), index: 0, addressHex: bytesToHex(TEST_ADDRESS), lovelace: '1', datumHash: '07'.repeat(32) });
    expect(utxoFromConfig(utxoToConfig(hashed))).toEqual(hashed);
  });
});

describe('a page wallet on a host ledger', () => {
  it('carries asset quantities above 2^53 through the binding unchanged', async () => {
    const unit = bytesToHex(h(9)) + '41';
    const w = prepareWallet({ utxos: [{ lovelace: 5_000_000, assets: { [unit]: '1152921504606846976' } }] });
    const page = pageWith(walletLedger(w));
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    const [hex] = (await (await enableChw(page)).getUtxos())!;
    const output = CSL.TransactionUnspentOutput.from_hex(hex!).output();
    expect(output.amount().multiasset()!.get_asset(CSL.ScriptHash.from_bytes(h(9)), CSL.AssetName.new(hexToBytes('41'))).to_str()).toBe('1152921504606846976');
  });

  it('reads, signs against and submits to the host ledger, and a new page sees the state', async () => {
    const w = prepareWallet();
    const node = walletLedger(w);
    const config = { ...w.config, ledger: { state: true, binding: LEDGER_BINDING } };
    const first = pageWith(node);
    installWallet(config, first);
    const api = await enableChw(first);
    expect(await api.getUtxos()).toHaveLength(1);

    const address = parseAddressArg(w.addresses.payment);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const tx = buildTx({ inputs: [utxo0.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
    const signed = spliceWitnessSet(tx, await api.signTx(tx, false));
    const id = await api.submitTx(signed);
    expect(id).toBe(bytesToHex(txHash(hexToBytes(signed))));

    // The host ledger holds the new state, a reloaded page reads it from there.
    expect((await node.getWalletUtxos()).map((u) => bytesToHex(u.input.txId))).toEqual([id]);
    const second = pageWith(node);
    installWallet(config, second);
    const utxos = (await (await enableChw(second)).getUtxos())!;
    expect(utxos).toHaveLength(1);
    expect(utxos[0]).toContain(id);
  });

  it('CIP-95 reads the registration from the host ledger', async () => {
    const w = prepareWallet();
    const node = walletLedger(w);
    const page = pageWith(node);
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    const address = parseAddressArg(w.addresses.payment);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const stakeKeyHash = parseAddressArg(w.addresses.reward).slice(1);
    await node.submit(hexToBytes(buildTx({ inputs: [utxo0.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[4n, [[7n, [0n, stakeKeyHash], 2_000_000n]]]]) })));
    const provider = (page.cardano as Record<string, { enable(o: unknown): Promise<unknown> }>)['chw']!;
    const { cip95 } = (await provider.enable({ extensions: [{ cip: 95 }] })) as { cip95: { getRegisteredPubStakeKeys(): Promise<string[]> } };
    expect(await cip95.getRegisteredPubStakeKeys()).toEqual([w.stakePublicKeyHex]);
  });

  it('resolves an input the host ledger does not know as unknown', async () => {
    const w = prepareWallet();
    const page = pageWith(walletLedger(w));
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    const api = await enableChw(page);
    const tx = buildTx({ inputs: [syntheticInput('nowhere', 0n)], outputs: [], fee: 1n });
    await expect(api.signTx(tx, false)).rejects.toThrow(/CHW_UNRESOLVED_INPUT/);
  });

  it('never touches the host ledger while the wallet installs', () => {
    const w = prepareWallet();
    const page = pageWith(walletLedger(w));
    const binding = vi.fn(page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>);
    page[LEDGER_BINDING] = binding;
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    expect(binding).toHaveBeenCalledTimes(0);
  });

  it('keeps its own ledger with a warning when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = prepareWallet();
    const page: InstallTarget = {};
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    expect(await (await enableChw(page)).getUtxos()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(LEDGER_BINDING));
  });

  it('rejects an unknown operation', async () => {
    await expect(ledgerBinding(walletLedger(prepareWallet()))(undefined, 'mint')).rejects.toThrow(/unknown ledger operation mint/);
  });
});

describe('submit answers through the binding', () => {
  const setup = () => {
    const w = prepareWallet();
    const node = walletLedger(w);
    const page = pageWith(node);
    installWallet({ ...w.config, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    return { node, page, tx: standardUnsignedTx(w.config.name) };
  };
  const caught = (run: () => Promise<unknown>) => rejectionOf(run());

  it('answers an accepted transaction with its id', async () => {
    const { node, tx } = setup();
    expect(await ledgerBinding(node)(undefined, 'submit', tx)).toEqual({ txId: bytesToHex(txHash(hexToBytes(tx))) });
  });

  it('carries a CIP-30 error as a value, the page throws it as the plain object', async () => {
    const { node, page, tx } = setup();
    const info = 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [])))]';
    vi.spyOn(node, 'submit').mockRejectedValue(txSendError(TxSendErrorCode.Failure, info));
    expect(await ledgerBinding(node)(undefined, 'submit', tx)).toEqual({ error: { code: 2, info } });
    const e = await caught(async () => (await enableChw(page)).submitTx(tx));
    expect(e).toEqual({ code: TxSendErrorCode.Failure, info });
    expect(e).not.toBeInstanceOf(Error);
  });

  it('keeps only code and info of a CIP-30 error', async () => {
    const { node, tx } = setup();
    vi.spyOn(node, 'submit').mockRejectedValue({ ...apiError(APIErrorCode.InvalidRequest, 'fee is missing'), stack: 'host' });
    expect(await ledgerBinding(node)(undefined, 'submit', tx)).toEqual({ error: { code: APIErrorCode.InvalidRequest, info: 'fee is missing' } });
  });

  it('carries a ChwError as code and message, the page rebuilds it with the same message', async () => {
    const { node, page, tx } = setup();
    const original = new ChwError('CHW_UNSUPPORTED_TX_FORM', 'bootstrap witnesses');
    vi.spyOn(node, 'submit').mockRejectedValue(original);
    expect(await ledgerBinding(node)(undefined, 'submit', tx)).toEqual({ chwError: { code: 'CHW_UNSUPPORTED_TX_FORM', message: 'bootstrap witnesses' } });
    const e = await caught(async () => (await enableChw(page)).submitTx(tx));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: original.code, message: original.message });
  });

  it.each(['CHW_EVALUATOR_UNAVAILABLE', 'CHW_EVALUATOR_FAILED'] as const)('carries %s into the page like every other harness diagnosis', async (code) => {
    const { node, page, tx } = setup();
    const original = new ChwError(code, 'the Plutus evaluator could not run');
    vi.spyOn(node, 'submit').mockRejectedValue(original);
    const e = await caught(async () => (await enableChw(page)).submitTx(tx));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code, message: original.message });
  });

  it('the submitFails quirk rejects in the page, the host ledger never sees the transaction', async () => {
    const w = prepareWallet();
    // Without checks the wallet ledger is the MemoryLedger, which counts what reached it.
    const node = walletLedger(w) as MemoryLedger;
    const submit = vi.spyOn(node, 'submit');
    const page = pageWith(node);
    const info = 'ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]';
    installWallet({ ...w.config, quirks: { submitFails: info }, ledger: { state: true, binding: LEDGER_BINDING } }, page);
    await expect((await enableChw(page)).submitTx(standardUnsignedTx(w.config.name))).rejects.toEqual({ code: TxSendErrorCode.Failure, info });
    expect(submit).not.toHaveBeenCalled();
    expect(node.submitted).toHaveLength(0);
  });

  it('throws anything else as it is', async () => {
    const { node, tx } = setup();
    vi.spyOn(node, 'submit').mockRejectedValue(new Error('ledger broke'));
    await expect(ledgerBinding(node)(undefined, 'submit', tx)).rejects.toThrow('ledger broke');
  });
});
