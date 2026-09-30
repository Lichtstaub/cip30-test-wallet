import { afterEach, describe, expect, it, vi } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex } from '../src/core/bytes.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { prepareWallet } from '../src/host/config.js';
import { LEDGER_BINDING, ledgerBinding, utxoToConfig, walletLedger } from '../src/host/ledger.js';
import { installWallet, syntheticOwnedUtxo, utxoFromConfig, type InstallTarget } from '../src/page/install.js';
import { buildTx, spliceWitnessSet } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';
import { hash28 as h, syntheticInput } from './helpers/synthetic.js';
import { hexToBytes } from '../src/core/bytes.js';

afterEach(() => vi.restoreAllMocks());

/** A page window whose binding goes through JSON like Playwright's, so nothing the page receives is a bigint or a Uint8Array. */
function pageWith(ledger: ReturnType<typeof walletLedger>): InstallTarget & Record<string, unknown> {
  const handler = ledgerBinding(ledger);
  const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
  return { [LEDGER_BINDING]: async (op: string, arg?: unknown) => json(await handler(undefined, op, json(arg))) };
}

describe('JSON shape of ledger UTxOs', () => {
  it('round trips assets above 2^53, datum hash, inline datum and script ref', () => {
    const utxo = utxoFromConfig({
      txId: 'aa'.repeat(32),
      index: 3,
      addressHex: '00' + '11'.repeat(28) + '22'.repeat(28),
      lovelace: '18446744073709551615',
      assets: { [bytesToHex(h(9)) + '41']: '1152921504606846976' },
      inlineDatum: 'd87980',
      scriptRef: '8203474601000022499d',
    });
    expect(utxoFromConfig(utxoToConfig(utxo))).toEqual(utxo);
    expect(utxoToConfig(utxo).assets).toEqual({ [bytesToHex(h(9)) + '41']: '1152921504606846976' });
    const hashed = utxoFromConfig({ txId: 'bb'.repeat(32), index: 0, addressHex: '00' + '11'.repeat(28) + '22'.repeat(28), lovelace: '1', datumHash: '07'.repeat(32) });
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
    expect(id).toBe(bytesToHex(parseTransaction(hexToBytes(signed)).hash));

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
