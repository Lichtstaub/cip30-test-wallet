import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { APIErrorCode } from '../src/core/errors.js';
import { prepareWallet } from '../src/host/config.js';
import { LEDGER_BINDING, walletLedger } from '../src/host/ledger.js';
import type { PageConfig } from '../src/page/config.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import type { Cip30Api } from '../src/page/provider.js';
import { attachWallet } from '../src/playwright/index.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { chwProvider, pageWith, rejectionOf, testConfig } from './helpers/page.js';

const REVOKED = { code: APIErrorCode.Refused, info: 'the wallet revoked the connection' };
const ORIGIN = 'https://dapp.test';
const unsigned = () => standardUnsignedTx('chw');

/** A sessionStorage stand-in that keeps its entries in a Map the test can read. */
function memoryStorage(): Storage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
  };
}

/** A promise the test opens by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * A page with the host binding, where the operation op waits for the returned gate before the
 * host answers it. entered resolves once the page asked for op.
 */
function bindingPage(grants: Set<string>, op: string, extra: Partial<PageConfig> = {}) {
  const ledger = walletLedger(prepareWallet());
  const page = pageWith(ledger, grants);
  const call = page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>;
  const gates = { held: gate(), entered: gate() };
  page[LEDGER_BINDING] = async (o: string, arg?: unknown) => {
    if (o === op) {
      const { held, entered } = gates;
      entered.open();
      await held.promise;
    }
    return call(o, arg);
  };
  const target = Object.assign(page, { location: { origin: ORIGIN } }) as InstallTarget;
  const control = installWallet(testConfig({ ledger: { state: true, binding: LEDGER_BINDING }, ...extra }), target);
  /** Fresh gates for the next call of op. */
  const arm = () => {
    gates.held = gate();
    gates.entered = gate();
    return gates;
  };
  return { target, control, ...gates, arm };
}

describe('revoke', () => {
  it('ends every method of an earlier api with Refused, cip95 and collateral included, and isEnabled answers false', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const provider = chwProvider(target);
    const api = await provider.enable({ extensions: [{ cip: 95 }] });
    expect(await provider.isEnabled()).toBe(true);
    await control.revoke();
    expect(await rejectionOf(api.getNetworkId())).toEqual(REVOKED);
    expect(await rejectionOf(api.cip95!.getPubDRepKey())).toEqual(REVOKED);
    expect(await rejectionOf(api.getCollateral!())).toEqual(REVOKED);
    expect(await rejectionOf(api.experimental!.getCollateral())).toEqual(REVOKED);
    expect(await rejectionOf(api.getUtxos())).toEqual(REVOKED);
    expect(await rejectionOf(api.signData('00', '00'))).toEqual(REVOKED);
    expect(await provider.isEnabled()).toBe(false);
  });

  it('a later enable() gives a live api while the revoked one stays ended', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const provider = chwProvider(target);
    const api = await provider.enable();
    await control.revoke();
    const api2 = await provider.enable();
    expect(await api2.getNetworkId()).toBe(0);
    expect(await provider.isEnabled()).toBe(true);
    expect(await rejectionOf(api.getNetworkId())).toEqual(REVOKED);
    await control.revoke();
    const api3 = await provider.enable();
    expect(await api3.getNetworkId()).toBe(0);
    expect(await rejectionOf(api2.getNetworkId())).toEqual(REVOKED);
  });

  it('ends a signTx hanging in signHangs with Refused, a later release finds nothing', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { signHangs: true } }), target);
    const api = await chwProvider(target).enable();
    const p = api.signTx(unsigned(), false);
    await tick();
    await control.revoke();
    expect(await rejectionOf(p)).toEqual(REVOKED);
    expect(control.release('signTx')).toBe(0);
    const entries = control.journal.filter((e) => e.method === 'signTx');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.error).toEqual(REVOKED);
    expect(entries[0]!.result).toBeUndefined();
  });

  it('ends a partialSign signTx that was still waiting for the ledger, before signHangs and without a witness', async () => {
    const { target, control, held, entered } = bindingPage(new Set(), 'resolveInput', { quirks: { signHangs: true } });
    const api = await chwProvider(target).enable();
    const p = api.signTx(unsigned(), true);
    await entered.promise;
    await control.revoke();
    const rejected = rejectionOf(p);
    held.open();
    await tick();
    expect(control.release('signTx')).toBe(0);
    expect(await rejected).toEqual(REVOKED);
    const entry = control.journal.find((e) => e.method === 'signTx')!;
    expect(entry.result).toBeUndefined();
  });

  it('gives no witness when the connection is revoked while signTx reads its inputs from the ledger', async () => {
    const { target, control, held, entered } = bindingPage(new Set(), 'resolveInput');
    const api = await chwProvider(target).enable();
    const p = api.signTx(unsigned(), false);
    await entered.promise;
    await control.revoke();
    const rejected = rejectionOf(p);
    held.open();
    expect(await rejected).toEqual(REVOKED);
    const entry = control.journal.find((e) => e.method === 'signTx')!;
    expect(entry.result).toBeUndefined();
  });

  it('with rememberEnable and sessionStorage removes the key of the current origin, a reload is not enabled', async () => {
    const storage = memoryStorage();
    const target = { location: { origin: ORIGIN }, sessionStorage: storage } as InstallTarget;
    const config = testConfig({ rememberEnable: true });
    const control = installWallet(config, target);
    await chwProvider(target).enable();
    expect(storage.entries.size).toBe(1);
    await control.revoke();
    expect(storage.entries.size).toBe(0);
    installWallet(config, target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('with rememberEnable and a binding removes the grant from the host set', async () => {
    const grants = new Set<string>();
    const { target, control, held } = bindingPage(grants, 'none', { rememberEnable: true });
    held.open();
    await chwProvider(target).enable();
    expect([...grants]).toEqual([ORIGIN]);
    await control.revoke();
    expect([...grants]).toEqual([]);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('an enable() still waiting for the host when revoke runs ends with Refused and leaves no grant', async () => {
    const grants = new Set<string>();
    const { target, control, held, entered } = bindingPage(grants, 'enableAdd', { rememberEnable: true });
    const provider = chwProvider(target);
    const e = provider.enable();
    await entered.promise;
    await control.revoke();
    held.open();
    expect(await rejectionOf(e)).toEqual(REVOKED);
    expect(grants.has(ORIGIN)).toBe(false);
    expect(await provider.isEnabled()).toBe(false);
  });

  it('an enable() interrupted by a second revoke, with no enable() succeeding in between, still ends with Refused', async () => {
    const grants = new Set<string>();
    const { target, control, held, arm } = bindingPage(grants, 'enableAdd', { rememberEnable: true });
    const provider = chwProvider(target);
    held.open();
    await provider.enable();
    await control.revoke();
    const second = arm();
    const e = provider.enable();
    await second.entered.promise;
    await control.revoke();
    second.held.open();
    expect(await rejectionOf(e)).toEqual(REVOKED);
    expect(grants.has(ORIGIN)).toBe(false);
    expect(await provider.isEnabled()).toBe(false);
  });

  it('does not throw without an enable() before it, and is not journaled', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    await control.revoke();
    await control.revoke();
    expect(control.journal).toEqual([]);
    const api = await chwProvider(target).enable();
    expect(await api.getNetworkId()).toBe(0);
  });

  it('reject keeps its UserDeclined error and count through abort', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ quirks: { signHangs: true } }), target);
    const api: Cip30Api = await chwProvider(target).enable();
    const p = api.signTx(unsigned(), false);
    await tick();
    expect(control.abort('signTx', new Error('gone'))).toBe(1);
    expect(await rejectionOf(p)).toEqual(new Error('gone'));
    expect(control.reject('signTx')).toBe(0);
  });
});

describe('enable memory failures', () => {
  /** A binding page whose host fails the operation op. */
  function failingPage(op: string) {
    const ledger = walletLedger(prepareWallet());
    const page = pageWith(ledger, new Set());
    const call = page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>;
    page[LEDGER_BINDING] = async (o: string, arg?: unknown) => {
      if (o === op) throw new Error('host failed');
      return call(o, arg);
    };
    const target = Object.assign(page, { location: { origin: ORIGIN } }) as InstallTarget;
    installWallet(testConfig({ rememberEnable: true, ledger: { state: true, binding: LEDGER_BINDING } }), target);
    return target;
  }

  it('a failing host on enableHas means not remembered, isEnabled answers false', async () => {
    const target = failingPage('enableHas');
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('a failing host on enableAdd means not remembered, enable() still connects', async () => {
    const target = failingPage('enableAdd');
    const provider = chwProvider(target);
    const api = await provider.enable();
    expect(await api.getNetworkId()).toBe(0);
    expect(await provider.isEnabled()).toBe(true);
  });
});

describe('revoke with a failing host', () => {
  it('a failing host on enableForget still revokes and resolves', async () => {
    const ledger = walletLedger(prepareWallet());
    const page = pageWith(ledger, new Set());
    const call = page[LEDGER_BINDING] as (op: string, arg?: unknown) => Promise<unknown>;
    page[LEDGER_BINDING] = async (o: string, arg?: unknown) => {
      if (o === 'enableForget') throw new Error('host failed');
      return call(o, arg);
    };
    const target = Object.assign(page, { location: { origin: ORIGIN } }) as InstallTarget;
    const control = installWallet(testConfig({ rememberEnable: true, ledger: { state: true, binding: LEDGER_BINDING } }), target);
    const api = await chwProvider(target).enable();
    await control.revoke();
    expect(await rejectionOf(api.getNetworkId())).toEqual(REVOKED);
  });
});

describe('WalletHandle.revoke', () => {
  /** A Page stand-in with frames whose evaluate records the call or throws the given error. */
  function fakePage(errors: Array<Error | undefined>) {
    const evaluated: number[] = [];
    let binding: ((source: unknown, op: string, arg?: unknown) => Promise<unknown>) | undefined;
    const frames = errors.map((error, i) => ({
      evaluate: async () => {
        if (error) throw error;
        evaluated.push(i);
      },
    }));
    const page = {
      exposeBinding: async (_name: string, fn: typeof binding) => {
        binding = fn;
      },
      addInitScript: async () => undefined,
      frames: () => frames,
    } as unknown as Page;
    return { page, evaluated, binding: () => binding! };
  }

  it('revokes every frame, skips detached ones, and throws the first other error after all frames ran', async () => {
    const failure = new Error('page.evaluate: something broke');
    const { page, evaluated } = fakePage([
      undefined,
      failure,
      new Error('frame.evaluate: Frame was detached'),
      new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation'),
      undefined,
      new Error('a second failure'),
    ]);
    const wallet = await attachWallet(page);
    expect(await rejectionOf(wallet.revoke())).toBe(failure);
    expect(evaluated).toEqual([0, 4]);
  });

  it('clears the remembered origins of the handle', async () => {
    const { page, binding } = fakePage([undefined]);
    const wallet = await attachWallet(page, { rememberEnable: true });
    await binding()(undefined, 'enableAdd', ORIGIN);
    expect(await binding()(undefined, 'enableHas', ORIGIN)).toEqual({ value: true });
    await wallet.revoke();
    expect(await binding()(undefined, 'enableHas', ORIGIN)).toEqual({ value: false });
  });

  it('with install: false touches no frame and does not throw', async () => {
    const { page, evaluated } = fakePage([new Error('must not be called')]);
    const wallet = await attachWallet(page, { install: false });
    await wallet.revoke();
    expect(evaluated).toEqual([]);
  });
});
