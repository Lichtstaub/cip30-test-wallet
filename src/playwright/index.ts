import { test as base, expect, type Page } from '@playwright/test';
import { initScript } from '../host/bundle.js';
import { prepareWallet, type WalletOptions } from '../host/config.js';
import type { JournalEntry, QuirkConfig, QuirkName } from '../page/config.js';

export { expectSignedBy } from '../host/assert.js';
export type { WalletOptions } from '../host/config.js';
export { expect };

export interface WalletHandle {
  readonly name: string;
  readonly addresses: { payment: string; reward: string };
  readonly paymentPublicKeyHex: string;
  readonly stakePublicKeyHex: string;
  /** Journal entries, optionally filtered by CIP-30 method name. */
  calls(method?: string): Promise<JournalEntry[]>;
  /** Hex CBOR of the last transaction handed to submitTx, never broadcast. */
  lastSubmittedTx(): Promise<string | undefined>;
  setQuirk<K extends QuirkName>(name: K, value: QuirkConfig[K]): Promise<void>;
  release(method: 'signTx'): Promise<number>;
  reject(method: 'signTx'): Promise<number>;
}

const NOT_INSTALLED_ON_PAGE = 'the headless wallet is not installed on this page: navigate first, or window.cardano is not writable';
const NOT_INSTALLED_FOR_TEST = 'the wallet was not installed for this test (walletOptions.install is false)';

type ChwWindow = { __chw?: { journal: JournalEntry[]; setQuirk: (a: string, b: unknown) => void; release: (a: string) => number; reject: (a: string) => number } };

function makeHandle(page: Page, prepared: ReturnType<typeof prepareWallet>): WalletHandle {
  return {
    name: prepared.config.name,
    addresses: prepared.addresses,
    paymentPublicKeyHex: prepared.paymentPublicKeyHex,
    stakePublicKeyHex: prepared.stakePublicKeyHex,
    calls: (method) =>
      page.evaluate(
        ([m, notInstalled]) => {
          const chw = (window as unknown as ChwWindow).__chw;
          if (!chw) throw new Error(notInstalled);
          return chw.journal.filter((e) => m === undefined || e.method === m);
        },
        [method, NOT_INSTALLED_ON_PAGE] as const,
      ),
    lastSubmittedTx: () =>
      page.evaluate((notInstalled) => {
        const chw = (window as unknown as ChwWindow).__chw;
        if (!chw) throw new Error(notInstalled);
        const last = [...chw.journal].reverse().find((e) => e.method === 'submitTx' && e.error === undefined);
        return last ? (last.args[0] as string) : undefined;
      }, NOT_INSTALLED_ON_PAGE),
    setQuirk: (name, value) =>
      page.evaluate(
        ([n, v, notInstalled]) => {
          const chw = (window as unknown as ChwWindow).__chw;
          if (!chw) throw new Error(notInstalled);
          chw.setQuirk(n as string, v);
        },
        [name, value, NOT_INSTALLED_ON_PAGE] as const,
      ),
    release: (method) =>
      page.evaluate(
        ([m, notInstalled]) => {
          const chw = (window as unknown as ChwWindow).__chw;
          if (!chw) throw new Error(notInstalled);
          return chw.release(m);
        },
        [method, NOT_INSTALLED_ON_PAGE] as const,
      ),
    reject: (method) =>
      page.evaluate(
        ([m, notInstalled]) => {
          const chw = (window as unknown as ChwWindow).__chw;
          if (!chw) throw new Error(notInstalled);
          return chw.reject(m);
        },
        [method, NOT_INSTALLED_ON_PAGE] as const,
      ),
  };
}

function makeUninstalledHandle(prepared: ReturnType<typeof prepareWallet>): WalletHandle {
  const notInstalled = () => Promise.reject(new Error(NOT_INSTALLED_FOR_TEST));
  return {
    name: prepared.config.name,
    addresses: prepared.addresses,
    paymentPublicKeyHex: prepared.paymentPublicKeyHex,
    stakePublicKeyHex: prepared.stakePublicKeyHex,
    calls: notInstalled,
    lastSubmittedTx: notInstalled,
    setQuirk: notInstalled,
    release: notInstalled,
    reject: notInstalled,
  };
}

export const test = base.extend<{ walletOptions: WalletOptions; wallet: WalletHandle }>({
  walletOptions: [{}, { option: true }],
  wallet: [
    async ({ page, walletOptions }, use) => {
      const prepared = prepareWallet(walletOptions);
      if (walletOptions.install === false) {
        await use(makeUninstalledHandle(prepared));
        return;
      }
      // The fixture is automatic, its init script is registered during fixture setup, before
      // hooks and the test body, so a test cannot register a provider ahead of it, only the
      // page itself can.
      await page.addInitScript({ content: initScript(prepared.config) });
      await use(makeHandle(page, prepared));
    },
    // auto: a test that only destructures page (never wallet) still needs the wallet
    // installed, since the point of the fixture is to have it show up in window.cardano.
    { auto: true },
  ],
});
