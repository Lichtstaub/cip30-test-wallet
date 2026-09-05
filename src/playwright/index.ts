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
  release(method: 'signTx'): Promise<void>;
  reject(method: 'signTx'): Promise<void>;
}

function makeHandle(page: Page, prepared: ReturnType<typeof prepareWallet>): WalletHandle {
  return {
    name: prepared.config.name,
    addresses: prepared.addresses,
    paymentPublicKeyHex: prepared.paymentPublicKeyHex,
    stakePublicKeyHex: prepared.stakePublicKeyHex,
    calls: (method) =>
      page.evaluate((m) => {
        const chw = (window as unknown as { __chw: { journal: JournalEntry[] } }).__chw;
        return chw.journal.filter((e) => m === undefined || e.method === m);
      }, method),
    lastSubmittedTx: async () => {
      const entries = await page.evaluate(() => (window as unknown as { __chw: { journal: JournalEntry[] } }).__chw.journal);
      const last = [...entries].reverse().find((e) => e.method === 'submitTx');
      return last ? (last.args[0] as string) : undefined;
    },
    setQuirk: (name, value) =>
      page.evaluate(
        ([n, v]) => (window as unknown as { __chw: { setQuirk: (a: string, b: unknown) => void } }).__chw.setQuirk(n as string, v),
        [name, value] as const,
      ),
    release: (method) => page.evaluate((m) => (window as unknown as { __chw: { release: (a: string) => void } }).__chw.release(m), method),
    reject: (method) => page.evaluate((m) => (window as unknown as { __chw: { reject: (a: string) => void } }).__chw.reject(m), method),
  };
}

export const test = base.extend<{ walletOptions: WalletOptions; wallet: WalletHandle }>({
  walletOptions: [{}, { option: true }],
  wallet: [
    async ({ page, walletOptions }, use) => {
      const prepared = prepareWallet(walletOptions);
      // Runs after any init script the test registered before requesting the fixture, so a
      // pre-existing window.cardano from the test is augmented, not replaced.
      await page.addInitScript({ content: initScript(prepared.config) });
      await use(makeHandle(page, prepared));
    },
    // auto: a test that only destructures page (never wallet) still needs the wallet
    // installed, since the point of the fixture is to have it show up in window.cardano.
    { auto: true },
  ],
});
