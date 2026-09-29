import { expect, test } from '../src/playwright/index.js';

const P = 'ab'.repeat(28);

test.describe('balance with a token', () => {
  test.use({ walletOptions: { utxos: [{ lovelace: 10_000_000, assets: { [P + '41']: 5 } }] } });

  test('the demo shows ADA and the number of token kinds', async ({ page }) => {
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText('chw');
    await page.locator('#connect').click();
    await expect(page.locator('#connect-result')).toHaveText('network 0');
    await page.locator('#balance').click();
    await expect(page.locator('#balance-result')).toHaveText('10000000 lovelace, 1 token kind');
  });
});

test('a wallet without tokens shows no token kinds', async ({ page }) => {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
  await page.locator('#balance').click();
  await expect(page.locator('#balance-result')).toHaveText('10000000 lovelace, 0 token kinds');
});
