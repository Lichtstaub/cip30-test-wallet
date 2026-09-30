import { test as base, expect, type Page } from '@playwright/test';
import { initScript } from '../host/bundle.js';
import { prepareWallet, type WalletOptions } from '../host/config.js';
import { LEDGER_BINDING, ledgerBinding, walletLedger } from '../host/ledger.js';
import { utxoToConfig, type LedgerUtxo } from '../page/utxo-config.js';
import type { MemoryLedger } from '../core/ledger.js';
import type { JournalEntry, QuirkConfig, QuirkName } from '../page/config.js';
import type { Control } from '../page/control.js';

export { expectSignedBy, expectSignedData } from '../host/assert.js';
export type { SignedDataExpectation, SignerRole } from '../host/assert.js';
export type { WalletOptions } from '../host/config.js';
export type { LedgerUtxo } from '../page/utxo-config.js';
export { expect };

export interface WalletHandle {
  readonly name: string;
  readonly addresses: { payment: string; reward: string };
  readonly paymentPublicKeyHex: string;
  readonly stakePublicKeyHex: string;
  readonly drepPublicKeyHex: string;
  readonly drepKeyHashHex: string;
  readonly drepId: string;
  /** Journal entries, optionally filtered by CIP-30 method name. cip95.* names work too. */
  calls(method?: string): Promise<JournalEntry[]>;
  /** Hex CBOR of the last transaction handed to submitTx, never broadcast. */
  lastSubmittedTx(): Promise<string | undefined>;
  /**
   * The wallet's unspent outputs as the ledger holds them after every submitted
   * transaction of this test, in the shape of walletOptions.foreignUtxos. Kept in
   * Node, so it survives reloads, navigations and origin changes.
   */
  utxos(): Promise<LedgerUtxo[]>;
  setQuirk<K extends QuirkName>(name: K, value: QuirkConfig[K]): Promise<void>;
  release(method: 'signTx'): Promise<number>;
  reject(method: 'signTx'): Promise<number>;
}

const NOT_INSTALLED_ON_PAGE = 'the test wallet is not installed on this page: navigate first, or window.cardano is not writable';
const NOT_INSTALLED_FOR_TEST = 'the wallet was not installed for this test (walletOptions.install is false)';

type ChwWindow = { __chw?: Control };

/** Runs the page-touching call, or rejects the way an uninstalled wallet always does. */
function guardInstalled<T>(installed: boolean, run: () => Promise<T>): Promise<T> {
  return installed ? run() : Promise.reject(new Error(NOT_INSTALLED_FOR_TEST));
}

function makeHandle(page: Page, prepared: ReturnType<typeof prepareWallet>, installed: boolean, ledger: MemoryLedger): WalletHandle {
  return {
    name: prepared.config.name,
    addresses: prepared.addresses,
    paymentPublicKeyHex: prepared.paymentPublicKeyHex,
    stakePublicKeyHex: prepared.stakePublicKeyHex,
    drepPublicKeyHex: prepared.drepPublicKeyHex,
    drepKeyHashHex: prepared.drepKeyHashHex,
    drepId: prepared.drepId,
    calls: (method) =>
      guardInstalled(installed, () =>
        page.evaluate(
          ([m, notInstalled]) => {
            const chw = (window as unknown as ChwWindow).__chw;
            if (!chw) throw new Error(notInstalled);
            return chw.journal.filter((e) => m === undefined || e.method === m);
          },
          [method, NOT_INSTALLED_ON_PAGE] as const,
        ),
      ),
    lastSubmittedTx: () =>
      guardInstalled(installed, () =>
        page.evaluate((notInstalled) => {
          const chw = (window as unknown as ChwWindow).__chw;
          if (!chw) throw new Error(notInstalled);
          for (let i = chw.journal.length - 1; i >= 0; i--) {
            const entry = chw.journal[i]!;
            if (entry.method === 'submitTx' && entry.error === undefined) return entry.args[0] as string;
          }
          return undefined;
        }, NOT_INSTALLED_ON_PAGE),
      ),
    utxos: async () => (await ledger.getWalletUtxos()).map(utxoToConfig),
    setQuirk: (name, value) =>
      guardInstalled(installed, () =>
        page.evaluate(
          ([n, v, notInstalled]) => {
            const chw = (window as unknown as ChwWindow).__chw;
            if (!chw) throw new Error(notInstalled);
            chw.setQuirk(n as never, v as never);
          },
          [name, value, NOT_INSTALLED_ON_PAGE] as const,
        ),
      ),
    release: (method) =>
      guardInstalled(installed, () =>
        page.evaluate(
          ([m, notInstalled]) => {
            const chw = (window as unknown as ChwWindow).__chw;
            if (!chw) throw new Error(notInstalled);
            return chw.release(m);
          },
          [method, NOT_INSTALLED_ON_PAGE] as const,
        ),
      ),
    reject: (method) =>
      guardInstalled(installed, () =>
        page.evaluate(
          ([m, notInstalled]) => {
            const chw = (window as unknown as ChwWindow).__chw;
            if (!chw) throw new Error(notInstalled);
            return chw.reject(m);
          },
          [method, NOT_INSTALLED_ON_PAGE] as const,
        ),
      ),
  };
}

const attached = new WeakSet<Page>();

/**
 * Installs the test wallet into a page without the test runner, the way the
 * fixture does: the ledger in Node behind a binding, so its state outlives
 * reloads, navigations and origin changes, and the provider through an init
 * script. Call it before the first navigation and once per page, never on a
 * page the test fixture already set up. Returns the handle the fixture gives a test.
 */
export async function attachWallet(page: Page, options: WalletOptions = {}): Promise<WalletHandle> {
  if (attached.has(page)) {
    throw new Error(
      'attachWallet already ran for this page. The test fixture from cip30-test-wallet/playwright calls it for every test, configure it with test.use({ walletOptions }) instead of calling attachWallet again',
    );
  }
  const prepared = prepareWallet(options);
  attached.add(page);
  const installed = options.install !== false;
  const ledger = walletLedger(prepared);
  if (installed) {
    // The binding first: the init script finds it at document start in every engine.
    await page.exposeBinding(LEDGER_BINDING, ledgerBinding(ledger));
    const config = { ...prepared.config, ledger: { ...prepared.config.ledger!, binding: LEDGER_BINDING } };
    await page.addInitScript({ content: initScript(config) });
  }
  return makeHandle(page, prepared, installed, ledger);
}

export const test = base.extend<{ walletOptions: WalletOptions; wallet: WalletHandle }>({
  walletOptions: [{}, { option: true }],
  wallet: [
    async ({ page, walletOptions }, use) => {
      // The fixture is automatic, its init script is registered during fixture setup, before
      // hooks and the test body, so a test cannot register a provider ahead of it, only the
      // page itself can. One ledger per test, in Node.
      await use(await attachWallet(page, walletOptions));
    },
    // auto: a test that only destructures page (never wallet) still needs the wallet
    // installed, since the point of the fixture is to have it show up in window.cardano.
    { auto: true },
  ],
});
