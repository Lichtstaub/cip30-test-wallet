import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { APIErrorCode, TxSignErrorCode } from '../src/core/errors.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { enableChw, testConfig } from './helpers/page.js';

const address = hexToBytes('00' + '11'.repeat(28) + '22'.repeat(28));
const unsigned = () => {
  const utxo = syntheticOwnedUtxo('chw', 0, address, 10_000_000n);
  return buildTx({ inputs: [utxo.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
};

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
    expect((target.cardano as Record<string, unknown>)['chw']).toBeDefined();
  });
});

describe('enableRejected', () => {
  it('throws APIError Refused from enable and stays disabled', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { enableRejected: true } }), target);
    const provider = (target.cardano as Record<string, { enable: () => Promise<unknown>; isEnabled: () => Promise<boolean> }>)['chw']!;
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

describe('journal redaction', () => {
  it('never contains key material, not even after errors', async () => {
    const config = testConfig({ quirks: { signRejected: true } });
    const target: InstallTarget = {};
    const control = installWallet(config, target);
    const api = await enableChw(target);
    await api.getUtxos();
    await api.getBalance();
    await api.signTx(unsigned(), false).catch(() => undefined);
    await api.submitTx('zz').catch(() => undefined);
    const text = JSON.stringify(control.journal);
    const secrets = [
      config.keys.payment.hex,
      config.keys.stake.hex,
      config.keys.payment.hex.slice(0, 64),
      config.keys.payment.hex.slice(64),
      config.keys.stake.hex.slice(0, 64),
      config.keys.stake.hex.slice(64),
    ];
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain('test walk nut');
    expect(control.journal.map((e) => e.method)).toEqual(['isEnabled', 'enable', 'getUtxos', 'getBalance', 'signTx', 'submitTx']);
  });
});
