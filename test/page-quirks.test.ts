import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { APIErrorCode, TxSignErrorCode } from '../src/core/errors.js';
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

describe('setQuirk validation', () => {
  it('rejects an unknown quirk name with InvalidRequest', () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    // Casting the name to never also collapses the value type to never, the runtime check is what is under test here.
    expect(() => control.setQuirk('signRejcted' as never, true as never)).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('rejects lateInjection after install with InvalidRequest, it only applies at install time', () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    expect(() => control.setQuirk('lateInjection', 100)).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
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
