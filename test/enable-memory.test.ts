import { describe, expect, it } from 'vitest';
import { APIErrorCode } from '../src/core/errors.js';
import { prepareWallet, type WalletOptions } from '../src/host/config.js';
import { LEDGER_BINDING, walletLedger } from '../src/host/ledger.js';
import type { PageConfig } from '../src/page/config.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { chwProvider, memoryStorage, pageWith, rejectionOf, testConfig } from './helpers/page.js';

/** A window with an origin and a sessionStorage, the way installWallet sees one in a browser. */
function windowAt(origin: string, storage: Storage | undefined = memoryStorage()): InstallTarget {
  return { location: { origin }, sessionStorage: storage } as InstallTarget;
}

const remembering = (overrides: Partial<PageConfig> = {}) => testConfig({ rememberEnable: true, ...overrides });

describe('rememberEnable', () => {
  it('without the option a reload forgets enable(), and a stored key changes nothing', async () => {
    const storage = memoryStorage();
    storage.setItem('__chw:enabled:chw', 'https://dapp.test');
    const target = windowAt('https://dapp.test', storage);
    installWallet(testConfig(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    await chwProvider(target).enable();
    expect(await chwProvider(target).isEnabled()).toBe(true);
    installWallet(testConfig(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    expect([...storage.entries.keys()]).toEqual(['__chw:enabled:chw']);
    expect(storage.entries.get('__chw:enabled:chw')).toBe('https://dapp.test');
  });

  it('without the option the wallet never touches sessionStorage', async () => {
    let touched = 0;
    const target = { location: { origin: 'https://dapp.test' } } as InstallTarget;
    Object.defineProperty(target, 'sessionStorage', {
      get: () => {
        touched++;
        return memoryStorage();
      },
    });
    installWallet(testConfig(), target);
    await chwProvider(target).isEnabled();
    await chwProvider(target).enable();
    installWallet(testConfig(), target);
    await chwProvider(target).isEnabled();
    expect(touched).toBe(0);
  });

  it('with sessionStorage a reload of the same origin is still enabled, another origin is not', async () => {
    const storage = memoryStorage();
    const target = windowAt('https://dapp.test', storage);
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    await chwProvider(target).enable();
    expect(storage.entries.get('__chw:enabled:chw')).toBe('https://dapp.test');
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(true);

    const other = windowAt('https://other.test', storage);
    installWallet(remembering(), other);
    expect(await chwProvider(other).isEnabled()).toBe(false);
  });

  it('the storage key carries the wallet name', async () => {
    const storage = memoryStorage();
    const target = windowAt('https://dapp.test', storage);
    installWallet(remembering({ name: 'eternl' }), target);
    await (target.cardano as Record<string, { enable(): Promise<unknown> }>)['eternl']!.enable();
    expect([...storage.entries.keys()]).toEqual(['__chw:enabled:eternl']);
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('an opaque origin remembers nothing', async () => {
    const storage = memoryStorage();
    const target = windowAt('null', storage);
    installWallet(remembering(), target);
    await chwProvider(target).enable();
    expect(await chwProvider(target).isEnabled()).toBe(true);
    expect(storage.entries.size).toBe(0);
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('a window without location counts as an opaque origin', async () => {
    const storage = memoryStorage();
    const target = { sessionStorage: storage } as InstallTarget;
    installWallet(remembering(), target);
    await chwProvider(target).enable();
    expect(storage.entries.size).toBe(0);
  });

  it('a sessionStorage that throws on access means nothing is remembered, without an error', async () => {
    const target = { location: { origin: 'https://dapp.test' } } as InstallTarget;
    Object.defineProperty(target, 'sessionStorage', {
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    await chwProvider(target).enable();
    expect(await chwProvider(target).isEnabled()).toBe(true);
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('a stored value for another origin counts as not remembered', async () => {
    const storage = memoryStorage();
    storage.setItem('__chw:enabled:chw', 'https://other.test');
    const target = windowAt('https://dapp.test', storage);
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    await chwProvider(target).enable();
    installWallet(remembering(), target);
    expect(await chwProvider(target).isEnabled()).toBe(true);
  });

  it('with a binding the grant lives in the host set, not in sessionStorage', async () => {
    const grants = new Set<string>();
    const storage = memoryStorage();
    const ledger = walletLedger(prepareWallet());
    const binding = pageWith(ledger, grants);
    const target = Object.assign(binding, { location: { origin: 'https://dapp.test' }, sessionStorage: storage }) as InstallTarget;
    const config = remembering({ ledger: { state: true, binding: LEDGER_BINDING } });
    installWallet(config, target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
    await chwProvider(target).enable();
    expect([...grants]).toEqual(['https://dapp.test']);
    expect(storage.entries.size).toBe(0);
    installWallet(config, target);
    expect(await chwProvider(target).isEnabled()).toBe(true);
  });

  it('the host set never takes an opaque origin', async () => {
    const grants = new Set<string>();
    const binding = pageWith(walletLedger(prepareWallet()), grants);
    const target = Object.assign(binding, { location: { origin: 'null' } }) as InstallTarget;
    const config = remembering({ ledger: { state: true, binding: LEDGER_BINDING } });
    installWallet(config, target);
    await chwProvider(target).enable();
    expect(grants.size).toBe(0);
  });

  it('isEnabled() is false, not just falsy, before and after a reload by default', async () => {
    const target = windowAt('https://dapp.test');
    installWallet(testConfig(), target);
    const provider = chwProvider(target);
    expect(await provider.isEnabled()).toBe(false);
    await provider.enable();
    installWallet(testConfig(), target);
    expect(await chwProvider(target).isEnabled()).toBe(false);
  });

  it('enableRejected beats a remembered grant: isEnabled() is true, enable() throws Refused', async () => {
    const target = windowAt('https://dapp.test');
    installWallet(remembering(), target);
    await chwProvider(target).enable();
    installWallet(remembering({ quirks: { enableRejected: true } }), target);
    expect(await chwProvider(target).isEnabled()).toBe(true);
    const error = await rejectionOf(chwProvider(target).enable());
    expect(error).toMatchObject({ code: APIErrorCode.Refused });
  });

  it('prepareWallet checks the option and puts it into the page config only when true', () => {
    expect(() => prepareWallet({ rememberEnable: 'yes' as never })).toThrow('walletOptions.rememberEnable must be a boolean, got yes');
    expect(() => prepareWallet({ rememberEnable: null as never })).toThrow('walletOptions.rememberEnable must be a boolean, got null');
    expect(prepareWallet({ rememberEnable: true } as WalletOptions).config.rememberEnable).toBe(true);
    expect(prepareWallet({ rememberEnable: false }).config.rememberEnable).toBeUndefined();
    expect(prepareWallet().config.rememberEnable).toBeUndefined();
  });
});
