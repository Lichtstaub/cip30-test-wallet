// Keeps the user-side failure table in docs/recipes.md honest: every error
// code the table promises is checked against the installed wallet.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { chwProvider, enableChw, testConfig } from './helpers/page.js';

const doc = readFileSync('docs/recipes.md', 'utf8');
const table = doc.slice(doc.indexOf('## User-side failures'), doc.indexOf('## Reading the journal'));

function promisedCode(quirk: string): number {
  const row = table.split('\n').find((line) => line.includes(`quirks: { ${quirk}: true }`));
  expect(row, `a table row for ${quirk}`).toBeDefined();
  return Number(/\{ code: (-?\d+) \}/.exec(row!)![1]);
}

describe('docs/recipes.md user-side failure table', () => {
  it('enableRejected rejects enable() with the code the table names', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { enableRejected: true } }), target);
    await expect(chwProvider(target).enable()).rejects.toMatchObject({ code: promisedCode('enableRejected') });
  });

  it('signRejected rejects signTx with the code the table names', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { signRejected: true } }), target);
    const api = await enableChw(target);
    await expect(api.signTx(standardUnsignedTx('chw'), false)).rejects.toMatchObject({ code: promisedCode('signRejected') });
  });

  it('signDataRejected rejects signData with the code the table names', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { signDataRejected: true } }), target);
    const api = await enableChw(target);
    const [reward] = await api.getRewardAddresses();
    await expect(api.signData(reward!, '00')).rejects.toMatchObject({ code: promisedCode('signDataRejected') });
  });

  it('noCip95 leaves supportedExtensions empty as the table says', () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { noCip95: true } }), target);
    expect(table).toContain('`supportedExtensions` is empty');
    expect(chwProvider(target).supportedExtensions).toEqual([]);
  });
});
