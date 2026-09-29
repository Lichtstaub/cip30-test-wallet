import { expect, expectSignedBy, test } from '../src/playwright/index.js';

async function connect(page: import('@playwright/test').Page) {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
}

test('a DRep vote is signed with the payment and the DRep key', async ({ page, wallet }) => {
  await connect(page);
  await page.locator('#vote').click();
  await expect(page.locator('#vote-result')).toHaveText(/^submitted [0-9a-f]{64}$/);
  expectSignedBy((await wallet.lastSubmittedTx())!, wallet, { roles: ['payment', 'drep'] });
});

test('a vote delegation is signed with the payment and the stake key', async ({ page, wallet }) => {
  await connect(page);
  await page.locator('#delegate').click();
  await expect(page.locator('#delegate-result')).toHaveText(/^submitted [0-9a-f]{64}$/);
  expectSignedBy((await wallet.lastSubmittedTx())!, wallet, { roles: ['payment', 'stake'] });
});

test.describe('noCip95', () => {
  test.use({ walletOptions: { quirks: { noCip95: true } } });
  test('the vote is refused with ProofGeneration', async ({ page }) => {
    await connect(page);
    await page.locator('#vote').click();
    await expect(page.locator('#vote-result')).toHaveText('error 1');
  });
});
