import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIErrorCode, ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { DEFAULT_MNEMONIC, prepareWallet, type WalletOptions } from '../src/host/config.js';
import { LEDGER_BINDING, walletLedger } from '../src/host/ledger.js';
import type { QuirkConfig } from '../src/page/config.js';
import { installWallet, syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx, standardUnsignedTx, witnessVkeys } from './helpers/build-tx.js';
import { enableChw, pageWith, rejectionOf } from './helpers/page.js';

afterEach(() => vi.restoreAllMocks());

/** The BIP-39 test vector, a mnemonic other than the default. */
const OTHER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const KOIOS_MAINNET = { chain: { provider: 'koios', network: 'mainnet' } } as const;
const OFFLINE_LOCKED = 'CHW_MAINNET_LOCKED: walletOptions.networkId is 1 with a custom mnemonic, signTx signs there only with walletOptions.allowMainnetSigning: true';
const CHAIN_LOCKED = 'CHW_MAINNET_LOCKED: the chain provider reports mainnet, signTx signs there only with walletOptions.allowMainnetSigning: true';
const OVERRIDE_WARNING = 'cip30-test-wallet: allowMainnetSigning is on with a custom mnemonic on mainnet, signTx signs transactions the dApp can submit with real funds';

const silentWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('prepareWallet sets signLocked', () => {
  it('on mainnet with a custom mnemonic', () => {
    const warn = silentWarn();
    expect(prepareWallet({ networkId: 1, mnemonic: OTHER }).config.signLocked).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['without a mnemonic', {}],
    ['with the default mnemonic in another spelling', { mnemonic: DEFAULT_MNEMONIC.toUpperCase() }],
  ])('not on mainnet %s', (_name, options: WalletOptions) => {
    const warn = silentWarn();
    expect(prepareWallet({ networkId: 1, ...options }).config.signLocked).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('not with allowMainnetSigning: true, and warns once', () => {
    const warn = silentWarn();
    expect(prepareWallet({ networkId: 1, mnemonic: OTHER, allowMainnetSigning: true }).config.signLocked).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(OVERRIDE_WARNING);
  });

  it('not on a test network with a custom mnemonic, without a warning', () => {
    const warn = silentWarn();
    expect(prepareWallet({ networkId: 0, mnemonic: OTHER }).config.signLocked).toBeUndefined();
    expect(prepareWallet({ networkId: 0, mnemonic: OTHER, allowMainnetSigning: true }).config.signLocked).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('on a mainnet chain with the default mnemonic, unless allowMainnetSigning is true', () => {
    expect(prepareWallet({ networkId: 1, ledger: KOIOS_MAINNET }).config.signLocked).toBe(true);
    expect(prepareWallet({ networkId: 1, ledger: KOIOS_MAINNET, allowMainnetSigning: false }).config.signLocked).toBe(true);
    expect(prepareWallet({ networkId: 1, ledger: KOIOS_MAINNET, allowMainnetSigning: true }).config.signLocked).toBeUndefined();
  });

  it.each([
    ['a string', 'true', 'walletOptions.allowMainnetSigning must be a boolean, got true'],
    ['null', null, 'walletOptions.allowMainnetSigning must be a boolean, got null'],
  ])('refuses allowMainnetSigning that is %s', (_name, value, message) => {
    expect(() => prepareWallet({ allowMainnetSigning: value as never })).toThrow(message);
  });

  it('names the new place of ledger.chain.allowMainnetSigning', () => {
    expect(() => prepareWallet({ ledger: { chain: { provider: 'koios', network: 'preprod', allowMainnetSigning: true } as never } })).toThrow(
      'ledger.chain.allowMainnetSigning moved to walletOptions.allowMainnetSigning',
    );
  });
});

/** A wallet on a host ledger, installed with the config prepareWallet built, plus the binding attachWallet adds. */
async function mainnetPage(options: WalletOptions, quirks: QuirkConfig = {}) {
  const w = prepareWallet(options);
  const page = pageWith(walletLedger(w));
  const binding = vi.fn(page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>);
  page[LEDGER_BINDING] = binding;
  installWallet({ ...w.config, quirks, ledger: { ...w.config.ledger!, binding: LEDGER_BINDING } }, page);
  const address = parseAddressArg(w.addresses.payment);
  return { w, binding, address, api: await enableChw(page), tx: standardUnsignedTx(w.config.name, address) };
}

const OFFLINE = { networkId: 1, mnemonic: OTHER } as const;

describe('signTx on mainnet with a custom mnemonic, offline', () => {
  it.each([false, true])('refuses a valid transaction with CHW_MAINNET_LOCKED at partialSign %s and never asks the ledger', async (partial) => {
    const { api, tx, binding } = await mainnetPage(OFFLINE);
    const e = await rejectionOf(api.signTx(tx, partial));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_MAINNET_LOCKED', message: OFFLINE_LOCKED });
    expect(binding).not.toHaveBeenCalled();
  });

  it.each([false, true])('still answers a malformed transaction with InvalidRequest at partialSign %s', async (partial) => {
    const { api } = await mainnetPage(OFFLINE);
    await expect(api.signTx('8200', partial)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('still answers a deprecated certificate with TxSignError DeprecatedCertificate', async () => {
    const { api, w, address } = await mainnetPage(OFFLINE);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const tx = buildTx({ inputs: [utxo0.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[4n, [[5n, 'anything']]]]) });
    await expect(api.signTx(tx, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.DeprecatedCertificate }));
  });

  it.each([{ signHangs: true }, { signRejected: true }] as const)('refuses before the prompt quirk %o, without a release', async (quirks) => {
    const { api, tx } = await mainnetPage(OFFLINE, quirks);
    await expect(api.signTx(tx, false)).rejects.toMatchObject({ code: 'CHW_MAINNET_LOCKED' });
  });

  it('signData still signs', async () => {
    const { api } = await mainnetPage(OFFLINE);
    const { signature, key } = await api.signData(await api.getChangeAddress(), 'cafe');
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('signs with allowMainnetSigning: true', async () => {
    silentWarn();
    const { api, tx, w } = await mainnetPage({ ...OFFLINE, allowMainnetSigning: true });
    expect(witnessVkeys(await api.signTx(tx, false))).toEqual([w.paymentPublicKeyHex]);
  });

  it('signs with the default mnemonic', async () => {
    const { api, tx, w } = await mainnetPage({ networkId: 1 });
    expect(witnessVkeys(await api.signTx(tx, false))).toEqual([w.paymentPublicKeyHex]);
  });
});

describe('signTx on a mainnet chain', () => {
  it.each([{}, { mnemonic: OTHER }])('refuses with the chain provider text, options %o', async (options) => {
    const { api, tx, binding } = await mainnetPage({ networkId: 1, ledger: KOIOS_MAINNET, ...options });
    const e = await rejectionOf(api.signTx(tx, false));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_MAINNET_LOCKED', message: CHAIN_LOCKED });
    expect(binding).not.toHaveBeenCalled();
  });
});
