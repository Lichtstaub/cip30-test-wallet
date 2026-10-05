// Keeps the user-side failure table in docs/recipes.md honest: every error
// code the table promises is checked against the installed wallet.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { scriptHash } from '../src/core/scripts.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { chwProvider, enableChw, testConfig } from './helpers/page.js';
import { plutusScript } from './helpers/plutus-fixtures.js';

const doc = readFileSync('docs/recipes.md', 'utf8');
const table = doc.slice(doc.indexOf('## User-side failures'), doc.indexOf('## Reading the journal'));

function tableRow(quirk: string): string {
  const row = table.split('\n').find((line) => line.includes(`quirks: { ${quirk}: `));
  expect(row, `a table row for ${quirk}`).toBeDefined();
  return row!;
}

function promisedCode(quirk: string): number {
  return Number(/\{ code: (-?\d+) \}/.exec(tableRow(quirk))![1]);
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

  it('submitFails rejects submitTx with the code the table names', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { submitFails: true } }), target);
    const api = await enableChw(target);
    await expect(api.submitTx(standardUnsignedTx('chw'))).rejects.toMatchObject({ code: promisedCode('submitFails') });
  });

  it('noCip95 leaves supportedExtensions empty as the table says', () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { noCip95: true } }), target);
    expect(table).toContain('`supportedExtensions` is empty');
    expect(chwProvider(target).supportedExtensions).toEqual([]);
  });
});

describe('docs/recipes.md script spending recipe', () => {
  // The aiken always_succeeds of test/fixtures/plutus, a script that passes when it runs.
  const always = plutusScript('v3_always_succeeds');
  const scriptAddress = '70' + always.hashHex;
  const referenceScript = bytesToHex(encode([3n, always.bytes]));

  it('keeps the values the test below uses', () => {
    expect(doc).toContain(referenceScript);
    expect(doc).toContain(scriptAddress);
  });

  it('is accepted by the wallet and its reference script hash is the credential of the script address', () => {
    expect(() =>
      prepareWallet({
        foreignUtxos: [
          { txId: 'aa'.repeat(32), index: 0, addressHex: scriptAddress, lovelace: 5_000_000, inlineDatum: 'd87980' },
          { txId: 'bb'.repeat(32), index: 0, addressHex: scriptAddress, lovelace: 20_000_000, scriptRef: referenceScript },
        ],
      }),
    ).not.toThrow();
    const hash = bytesToHex(scriptHash(3, always.bytes));
    expect(hash).toBe('5d0f747d4eb70739ff667eed99b934de3a3e5054fae1e368902078e3');
    expect(scriptAddress).toBe('70' + hash);
  });
});
