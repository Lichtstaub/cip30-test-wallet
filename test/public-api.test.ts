// Pins the runtime surface of both entry points. A new export is a promise to
// users, so adding one should be a deliberate change to this list.
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.js';
import * as playwright from '../src/playwright/index.js';

describe('public API', () => {
  it('main entry exports only the documented names', () => {
    expect(Object.keys(main).sort()).toEqual([
      'APIErrorCode',
      'ChwError',
      'DEFAULT_MNEMONIC',
      'DataSignErrorCode',
      'QUIRK_NAMES',
      'TxSignErrorCode',
      'expectSignedBy',
      'expectSignedData',
      'initScript',
      'prepareWallet',
    ]);
  });

  it('playwright entry exports the fixture and the assertions', () => {
    expect(Object.keys(playwright).sort()).toEqual(['expect', 'expectSignedBy', 'expectSignedData', 'test']);
  });
});
