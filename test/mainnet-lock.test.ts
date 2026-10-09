import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIErrorCode, ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { prepareWallet } from '../src/host/config.js';
import { LEDGER_BINDING, walletLedger } from '../src/host/ledger.js';
import type { QuirkConfig } from '../src/page/config.js';
import { installWallet, syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx, standardUnsignedTx, witnessVkeys } from './helpers/build-tx.js';
import { enableChw, pageWith, rejectionOf } from './helpers/page.js';

afterEach(() => vi.restoreAllMocks());

const LOCKED = 'CHW_MAINNET_LOCKED: the chain provider reports mainnet, signTx signs there only with walletOptions.ledger.chain.allowMainnetSigning: true';

/** A mainnet wallet on a host ledger, with the flag attachWallet sets for a mainnet chain without allowMainnetSigning. */
async function mainnetPage(opts: { locked?: boolean; quirks?: QuirkConfig } = {}) {
  const w = prepareWallet({ networkId: 1 });
  const page = pageWith(walletLedger(w));
  const binding = vi.fn(page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>);
  page[LEDGER_BINDING] = binding;
  const lock = opts.locked === false ? {} : { signLocked: true as const };
  installWallet({ ...w.config, quirks: opts.quirks ?? {}, ledger: { state: true, binding: LEDGER_BINDING, chain: true, ...lock } }, page);
  const address = parseAddressArg(w.addresses.payment);
  return { w, binding, address, api: await enableChw(page), tx: standardUnsignedTx(w.config.name, address) };
}

describe('signTx on a mainnet chain without allowMainnetSigning', () => {
  it.each([false, true])('refuses a valid transaction with CHW_MAINNET_LOCKED at partialSign %s and never asks the ledger', async (partial) => {
    const { api, tx, binding } = await mainnetPage();
    const e = await rejectionOf(api.signTx(tx, partial));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_MAINNET_LOCKED', message: LOCKED });
    expect(binding).not.toHaveBeenCalled();
  });

  it.each([false, true])('still answers a malformed transaction with InvalidRequest at partialSign %s', async (partial) => {
    const { api } = await mainnetPage();
    await expect(api.signTx('8200', partial)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('still answers a deprecated certificate with TxSignError DeprecatedCertificate', async () => {
    const { api, w, address } = await mainnetPage();
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const tx = buildTx({ inputs: [utxo0.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[4n, [[5n, 'anything']]]]) });
    await expect(api.signTx(tx, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.DeprecatedCertificate }));
  });

  it.each([{ signHangs: true }, { signRejected: true }] as const)('refuses before the prompt quirk %o, without a release', async (quirks) => {
    const { api, tx } = await mainnetPage({ quirks });
    await expect(api.signTx(tx, false)).rejects.toMatchObject({ code: 'CHW_MAINNET_LOCKED' });
  });

  it('signData still signs', async () => {
    const { api } = await mainnetPage();
    const { signature, key } = await api.signData(await api.getChangeAddress(), 'cafe');
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('without the flag a mainnet wallet signs as before', async () => {
    const { api, tx, w } = await mainnetPage({ locked: false });
    expect(witnessVkeys(await api.signTx(tx, false))).toEqual([w.paymentPublicKeyHex]);
  });
});
