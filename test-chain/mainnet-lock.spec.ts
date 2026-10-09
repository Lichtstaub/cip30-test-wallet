// The mainnet lock against Koios mainnet, read only: nothing is ever submitted.
// Manual, never in CI: CHW_CHAIN_MAINNET=1 npm run test:chain -- mainnet-lock
import type { Page } from '@playwright/test';
import { bytesToHex } from '../src/core/bytes.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { expect, expectSignedData, test } from '../src/playwright/index.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { syntheticInput } from '../test/helpers/synthetic.js';

type Api = {
  getUtxos(): Promise<string[] | null>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
};
type ChwWindow = { cardano: { chw: { enable(): Promise<Api> } } };
type Outcome = { signed: true } | { signed: false; code: unknown; info: unknown };

test.skip(!process.env.CHW_CHAIN_MAINNET, 'reads Koios mainnet, run it with CHW_CHAIN_MAINNET=1');
test.use({ walletOptions: { networkId: 1, ledger: { chain: { provider: 'koios', network: 'mainnet' } } } });

/** signTx in the page, its rejection caught there, so a CIP-30 object and a ChwError both come back as data. */
function signTxOutcome(page: Page, tx: string, partialSign: boolean): Promise<Outcome> {
  return page.evaluate(
    async ([hex, partial]) => {
      const api = await (window as unknown as ChwWindow).cardano.chw.enable();
      try {
        await api.signTx(hex, partial);
        return { signed: true as const };
      } catch (e) {
        const error = e as { code?: unknown; info?: unknown };
        return { signed: false as const, code: error.code, info: error.info };
      }
    },
    [tx, partialSign] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
});

test('signTx refuses a well-formed transaction with CHW_MAINNET_LOCKED at both partialSign values', async ({ page, wallet }) => {
  const own = parseAddressArg(wallet.addresses.payment);
  const tx = buildTx({ inputs: [syntheticInput('mainnet lock', 0n)], outputs: [{ address: own, lovelace: 2_000_000n }], fee: 200_000n });
  expect(await signTxOutcome(page, tx, false)).toMatchObject({ signed: false, code: 'CHW_MAINNET_LOCKED' });
  expect(await signTxOutcome(page, tx, true)).toMatchObject({ signed: false, code: 'CHW_MAINNET_LOCKED' });
  expect(await wallet.calls('submitTx')).toEqual([]);
});

test('a malformed transaction stays InvalidRequest', async ({ page }) => {
  expect(await signTxOutcome(page, 'deadbeef', false)).toMatchObject({ signed: false, code: -1 });
  expect(await signTxOutcome(page, 'deadbeef', true)).toMatchObject({ signed: false, code: -1 });
});

test('signData still signs, with the stake key for the reward address', async ({ page, wallet }) => {
  const payload = bytesToHex(new TextEncoder().encode('mainnet login'));
  const { address, result } = await page.evaluate(async (p) => {
    const api = await (window as unknown as ChwWindow).cardano.chw.enable();
    const [reward] = await api.getRewardAddresses();
    return { address: reward!, result: await api.signData(reward!, p) };
  }, payload);
  expectSignedData(result, { payload, address, publicKeyHex: wallet.stakePublicKeyHex });
});

test('getUtxos reads the mainnet address through Koios', async ({ page }) => {
  const utxos = await page.evaluate(async () => (await (window as unknown as ChwWindow).cardano.chw.enable()).getUtxos());
  expect(Array.isArray(utxos)).toBe(true);
});
