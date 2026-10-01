import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { APIErrorCode, TxSendErrorCode, TxSignErrorCode } from '../src/core/errors.js';
import { keyHash } from '../src/core/hash.js';
import { publicKey } from '../src/core/keys.js';
import { deriveAccount } from '../src/derive/index.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { MNEMONIC } from './fixtures/vectors.js';
import { chwProvider, enableChw, testConfig } from './helpers/page.js';

const unsigned = () => standardUnsignedTx('chw');

afterEach(() => vi.useRealTimers());

describe('lateInjection', () => {
  it('defines the provider only after the delay, the control object at once', () => {
    vi.useFakeTimers();
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { lateInjection: 800 } }), target);
    expect(target.__chw).toBe(control);
    expect(target.cardano).toBeUndefined();
    vi.advanceTimersByTime(799);
    expect(target.cardano).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(chwProvider(target)).toBeDefined();
  });
});

describe('answersEveryKey', () => {
  it('answers every unknown key with the wallet while keys and the in operator see only real entries', async () => {
    const other = { marker: true };
    const target: InstallTarget = { cardano: { other } };
    installWallet(testConfig({ quirks: { answersEveryKey: true } }), target);
    const ns = target.cardano as Record<string, unknown>;
    const provider = chwProvider(target);
    for (const key of ['nami', 'eternl', 'lace', 'vespr', 'anything_at_all']) expect(ns[key]).toBe(provider);
    expect(ns['other']).toBe(other);
    expect(Object.keys(ns)).toEqual(['other', 'chw']);
    expect('nami' in ns).toBe(false);
    expect(Object.getOwnPropertyDescriptor(ns, 'nami')).toBeUndefined();
    expect(typeof ns['hasOwnProperty']).toBe('function');
    const api = (await (ns['nami'] as typeof provider).enable()) as { getNetworkId: () => Promise<number> };
    expect(await api.getNetworkId()).toBe(0);
  });

  it('applies to the namespace once a late wallet appears', () => {
    vi.useFakeTimers();
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { answersEveryKey: true, lateInjection: 300 } }), target);
    expect(target.cardano).toBeUndefined();
    vi.advanceTimersByTime(300);
    expect((target.cardano as Record<string, unknown>)['nami']).toBe(chwProvider(target));
  });

  it('keeps a wallet that injects after it under its own key', () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { answersEveryKey: true } }), target);
    const late = { name: 'Late' };
    (target.cardano as Record<string, unknown>)['late'] = late;
    expect((target.cardano as Record<string, unknown>)['late']).toBe(late);
    expect(Object.keys(target.cardano as object)).toEqual(['chw', 'late']);
  });

  it('leaves window.cardano a plain object without the quirk', () => {
    const target: InstallTarget = {};
    installWallet(testConfig(), target);
    expect((target.cardano as Record<string, unknown>)['nami']).toBeUndefined();
  });
});

describe('enableRejected', () => {
  it('throws APIError Refused from enable and stays disabled', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { enableRejected: true } }), target);
    const provider = chwProvider(target);
    await expect(provider.enable()).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.Refused }));
    expect(await provider.isEnabled()).toBe(false);
  });
});

describe('signRejected', () => {
  it('throws TxSignError UserDeclined as a plain object', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { signRejected: true } }), target);
    const api = await enableChw(target);
    let caught: unknown;
    try {
      await api.signTx(unsigned(), false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toEqual({ code: TxSignErrorCode.UserDeclined, info: expect.any(String) });
    expect(caught).not.toBeInstanceOf(Error);
  });

  it('can be switched on at runtime through setQuirk', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const api = await enableChw(target);
    await api.signTx(unsigned(), false);
    control.setQuirk('signRejected', true);
    await expect(api.signTx(unsigned(), false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.UserDeclined }));
  });
});

describe('signHangs', () => {
  it('holds signTx until release, then signs', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { signHangs: true } }), target);
    const api = await enableChw(target);
    let settled = false;
    const pending = api.signTx(unsigned(), false).then((ws) => {
      settled = true;
      return ws;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    control.release('signTx');
    const ws = await pending;
    expect(settled).toBe(true);
    expect(ws.startsWith('a1')).toBe(true);
  });

  it('holds signTx until reject, then fails as UserDeclined', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { signHangs: true } }), target);
    const api = await enableChw(target);
    const pending = api.signTx(unsigned(), false);
    control.reject('signTx');
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.UserDeclined }));
  });
});

describe('submitRejected', () => {
  const info = 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Mismatch (RelGTEQ) {supplied: Coin 1, expected: Coin 170000})))]';

  it('throws TxSendError Failure with the configured info as a plain object and journals it', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { submitRejected: info } }), target);
    const api = await enableChw(target);
    let caught: unknown;
    try {
      await api.submitTx(unsigned());
    } catch (e) {
      caught = e;
    }
    expect(caught).toEqual({ code: TxSendErrorCode.Failure, info });
    expect(caught).not.toBeInstanceOf(Error);
    expect(control.journal.at(-1)).toMatchObject({ method: 'submitTx', args: [unsigned()], error: { code: TxSendErrorCode.Failure, info } });
    // The ledger never saw the transaction.
    expect(await api.getUtxos()).toHaveLength(2);
  });

  it('refuses malformed hex as InvalidRequest first', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { submitRejected: info } }), target);
    const api = await enableChw(target);
    await expect(api.submitTx('zz')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('can be switched on and off at runtime through setQuirk', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const api = await enableChw(target);
    control.setQuirk('submitRejected', info);
    await expect(api.submitTx(unsigned())).rejects.toEqual({ code: TxSendErrorCode.Failure, info });
    control.setQuirk('submitRejected', undefined);
    expect(await api.submitTx(unsigned())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('setQuirk validation', () => {
  it.each([
    ['true', true],
    ['an empty string', ''],
    ['a number', 7],
  ])('rejects submitRejected as %s with InvalidRequest and keeps the quirk off', (_name, value) => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    expect(() => control.setQuirk('submitRejected', value as never)).toThrow(
      expect.objectContaining({ code: APIErrorCode.InvalidRequest, info: expect.stringContaining('quirks.submitRejected must be a non-empty string') }),
    );
    expect(control.quirks.submitRejected).toBeUndefined();
  });

  it('rejects an unknown quirk name with InvalidRequest', () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    // Casting the name to never also collapses the value type to never, the runtime check is what is under test here.
    expect(() => control.setQuirk('signRejcted' as never, true as never)).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it.each([
    ['lateInjection', 100],
    ['answersEveryKey', true],
  ] as const)('rejects %s after install with InvalidRequest, it only applies at install time', (name, value) => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    expect(() => control.setQuirk(name, value as never)).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});

describe('release and reject return the settled count', () => {
  it('release returns 0 with nothing pending and 1 with one pending call', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { signHangs: true } }), target);
    expect(control.release('signTx')).toBe(0);
    const api = await enableChw(target);
    const pending = api.signTx(unsigned(), false);
    await new Promise((r) => setTimeout(r, 20));
    expect(control.release('signTx')).toBe(1);
    await pending;
  });
});

describe('journal redaction', () => {
  it('never contains key material, not even after errors, including signData and cip95', async () => {
    const config = testConfig({ quirks: { signRejected: true } });
    const target: InstallTarget = {};
    const control = installWallet(config, target);
    const provider = chwProvider(target);
    await provider.isEnabled();
    const api = await provider.enable({ extensions: [{ cip: 95 }] });
    await api.getUtxos();
    await api.getBalance();
    await api.signTx(unsigned(), false).catch(() => undefined);
    await api.submitTx('zz').catch(() => undefined);
    const [reward] = await api.getRewardAddresses();
    await api.signData(reward!, 'deadbeef');
    // A bare 28 byte hash is only valid addr shape through the cip95 namespace, so this
    // fails the CIP-30 signData call and exercises the error path of the journal too.
    await api.signData('ab'.repeat(28), 'deadbeef').catch(() => undefined);
    const account = deriveAccount(MNEMONIC);
    const drepBareId = bytesToHex(keyHash(publicKey(account.drep)));
    await api.cip95!.getPubDRepKey();
    await api.cip95!.getRegisteredPubStakeKeys();
    await api.cip95!.getUnregisteredPubStakeKeys();
    await api.cip95!.signData(drepBareId, 'deadbeef');
    const text = JSON.stringify(control.journal);
    const secrets = [
      config.keys.payment.hex,
      config.keys.stake.hex,
      config.keys.drep.hex,
      config.keys.payment.hex.slice(0, 64),
      config.keys.payment.hex.slice(64),
      config.keys.stake.hex.slice(0, 64),
      config.keys.stake.hex.slice(64),
      config.keys.drep.hex.slice(0, 64),
      config.keys.drep.hex.slice(64),
    ];
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain('test walk nut');
    expect(control.journal.map((e) => e.method)).toEqual([
      'isEnabled',
      'enable',
      'getUtxos',
      'getBalance',
      'signTx',
      'submitTx',
      'getRewardAddresses',
      'signData',
      'signData',
      'cip95.getPubDRepKey',
      'cip95.getRegisteredPubStakeKeys',
      'cip95.getUnregisteredPubStakeKeys',
      'cip95.signData',
    ]);
  });
});
