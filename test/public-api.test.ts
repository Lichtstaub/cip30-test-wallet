// Pins the runtime surface of both entry points. A new export is a promise to
// users, so adding one should be a deliberate change to this list.
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.js';
import type { ChainOptions } from '../src/index.js';
import * as playwright from '../src/playwright/index.js';
import type { ChainOptions as PlaywrightChainOptions } from '../src/playwright/index.js';

describe('public API', () => {
  it('main entry exports only the documented names', () => {
    expect(Object.keys(main).sort()).toEqual([
      'APIErrorCode',
      'ChwError',
      'DEFAULT_MNEMONIC',
      'DataSignErrorCode',
      'QUIRK_NAMES',
      'TxSendErrorCode',
      'TxSignErrorCode',
      'expectSignedBy',
      'expectSignedData',
      'initScript',
      'prepareWallet',
    ]);
  });

  it('playwright entry exports the fixture and the assertions', () => {
    expect(Object.keys(playwright).sort()).toEqual(['attachWallet', 'expect', 'expectSignedBy', 'expectSignedData', 'test']);
  });

  it('both entries export the ChainOptions type of walletOptions.ledger.chain, the runtime lists above stay as they are', () => {
    const ogmios: ChainOptions = { provider: 'ogmios', url: 'http://localhost:1337' };
    const koios: PlaywrightChainOptions = { provider: 'koios', network: 'preprod' };
    expect(main.prepareWallet({ ledger: { chain: ogmios } }).chain).toEqual(ogmios);
    expect(main.prepareWallet({ ledger: { chain: koios } }).chain).toEqual({ ...koios, url: 'https://preprod.koios.rest/api/v1' });
  });
});
