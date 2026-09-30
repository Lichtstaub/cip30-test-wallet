import { Address, Assets, Transaction } from '@evolution-sdk/evolution';
import { test as base, type Page } from '@playwright/test';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { syntheticOwnedUtxo, utxoFromConfig } from '../src/page/install.js';
import { attachWallet, expect, test } from '../src/playwright/index.js';
import { buildTx, spliceWitnessSet } from '../test/helpers/build-tx.js';
import { evolutionBuild, evolutionUtxo } from '../test/helpers/evolution-build.js';

type Api = {
  getUtxos(): Promise<string[] | null>;
  signTx(tx: string, partialSign: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
  cip95?: { getRegisteredPubStakeKeys(): Promise<string[]> };
};
type ChwWindow = { cardano: { chw: { enable(o?: unknown): Promise<Api> } } };

async function connect(page: Page, url = '/strict/') {
  await page.goto(url);
  await expect(page.locator('#wallets')).toHaveText('chw');
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
}

async function commit(page: Page): Promise<string> {
  await page.locator('#commit').click();
  await expect(page.locator('#commit-result')).toHaveText(/^submitted [0-9a-f]{64}$/);
  return (await page.locator('#commit-result').textContent())!.replace('submitted ', '');
}

/** The page's own getUtxos() hex list, so a page that fell back to a ledger of its own shows up as different ids. */
const pageUtxos = (page: Page) => page.evaluate(async () => (await (await (window as unknown as ChwWindow).cardano.chw.enable()).getUtxos()) ?? []);

/** The page lists exactly the outputs the Node ledger shows, every entry carrying the expected tx id. */
function expectPageMatches(list: string[], expectedIds: string[]) {
  expect(list).toHaveLength(expectedIds.length);
  expectedIds.forEach((id, i) => expect(list[i]).toContain(id));
}

test('the commit spends UTxO 0 and pays back to the wallet', async ({ page, wallet }) => {
  await connect(page);
  const id = await commit(page);
  const utxos = await wallet.utxos();
  expect(utxos).toHaveLength(1);
  expect(utxos[0]!.txId).toBe(id);
});

test('a second transaction spends the change of the first, across a reload and an origin change', async ({ page, wallet }) => {
  await connect(page);
  const firstId = await commit(page);
  const afterFirst = await wallet.utxos();
  expect(afterFirst.length).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator('#wallets')).toHaveText('chw');
  expect(await wallet.utxos()).toEqual(afterFirst);
  await page.goto('http://127.0.0.1:4173/permissive/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  expectPageMatches(await pageUtxos(page), afterFirst.map((u) => u.txId));
  expect(afterFirst.every((u) => u.txId === firstId)).toBe(true);

  const address = parseAddressArg(wallet.addresses.payment);
  const available = afterFirst.map((c) => evolutionUtxo(utxoFromConfig(c), address));
  const second = await evolutionBuild((b) => b.payToAddress({ address: Address.fromBytes(address), assets: Assets.fromLovelace(2_000_000n) }), address, available);
  const witnessSet = await page.evaluate(async (tx) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(tx, true), second);
  const signed = Transaction.addVKeyWitnessesHex(second, witnessSet);
  const secondId = await page.evaluate(async (tx) => (await (window as unknown as ChwWindow).cardano.chw.enable()).submitTx(tx), signed);

  const spent = parseTransaction(hexToBytes(signed)).body.inputs.map((i) => bytesToHex(i.txId) + '#' + i.index);
  const now = await wallet.utxos();
  expect(now.some((u) => u.txId === secondId)).toBe(true);
  expect(now.some((u) => spent.includes(u.txId + '#' + u.index))).toBe(false);
  expect(spent.every((s) => s.startsWith(firstId))).toBe(true);
});

test('a page that clears its storage does not reset the wallet', async ({ page, wallet }) => {
  await connect(page);
  await commit(page);
  const utxo0 = bytesToHex(syntheticOwnedUtxo(wallet.name, 0, parseAddressArg(wallet.addresses.payment), 10_000_000n).input.txId);
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  await page.reload();
  await expect(page.locator('#wallets')).toHaveText('chw');
  const utxos = await wallet.utxos();
  expect(utxos.some((u) => u.txId === utxo0)).toBe(false);
  expectPageMatches(await pageUtxos(page), utxos.map((u) => u.txId));
});

test('a stake registration shows up in CIP-95 and stays after a reload', async ({ page, wallet }) => {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  const address = parseAddressArg(wallet.addresses.payment);
  const stakeKeyHash = parseAddressArg(wallet.addresses.reward).slice(1);
  const utxo0 = syntheticOwnedUtxo(wallet.name, 0, address, 10_000_000n);
  const tx = buildTx({ inputs: [utxo0.input], outputs: [{ address, lovelace: 7_000_000n }], fee: 1_000_000n, extraBodyEntries: new Map([[4n, [[7n, [0n, stakeKeyHash], 2_000_000n]]]]) });
  const registered = async () =>
    page.evaluate(async () => (await (window as unknown as ChwWindow).cardano.chw.enable({ extensions: [{ cip: 95 }] })).cip95!.getRegisteredPubStakeKeys());
  expect(await registered()).toEqual([]);
  const witnessSet = await page.evaluate(async (t) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(t, false), tx);
  await page.evaluate(async (t) => (await (window as unknown as ChwWindow).cardano.chw.enable()).submitTx(t), spliceWitnessSet(tx, witnessSet));
  expect(await registered()).toEqual([wallet.stakePublicKeyHex]);
  await page.reload();
  await expect(page.locator('#wallets')).toHaveText('chw');
  expect(await registered()).toEqual([wallet.stakePublicKeyHex]);
});

test.describe('ledger state switched off', () => {
  test.use({ walletOptions: { ledger: { state: false } } });
  test('the configured UTxO stays after a submit', async ({ page, wallet }) => {
    await connect(page);
    await commit(page);
    const utxo0 = bytesToHex(syntheticOwnedUtxo(wallet.name, 0, parseAddressArg(wallet.addresses.payment), 10_000_000n).input.txId);
    expect((await wallet.utxos()).map((u) => u.txId)).toEqual([utxo0]);
  });
});

test('wallet.utxos() works before the first navigation', async ({ wallet }) => {
  expect(await wallet.utxos()).toHaveLength(1);
});

base('attachWallet keeps the ledger in Node without the test runner fixture', async ({ page }) => {
  const wallet = await attachWallet(page);
  await connect(page);
  const id = await commit(page);
  await page.reload();
  await expect(page.locator('#wallets')).toHaveText('chw');
  const list = await pageUtxos(page);
  expect(list).toHaveLength(1);
  expect(list[0]).toContain(id);
  expect((await wallet.utxos())[0]!.txId).toBe(id);
});

base('attachWallet twice on one page rejects', async ({ page }) => {
  await attachWallet(page);
  await expect(attachWallet(page)).rejects.toThrow(/already ran for this page/);
});
