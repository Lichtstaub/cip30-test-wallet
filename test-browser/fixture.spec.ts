import { expect, test } from '../src/playwright/index.js';

test.describe('fixture basics', () => {
  test('the demo lists the headless wallet and connects to it', async ({ page, wallet }) => {
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText('chw');
    await page.locator('#connect').click();
    await expect(page.locator('#connect-result')).toHaveText('network 0');
    expect(await wallet.calls('enable')).toHaveLength(1);
    expect(await wallet.calls('getNetworkId')).toHaveLength(1);
    expect(wallet.addresses.payment.startsWith('addr_test1')).toBe(true);
  });

  test('a custom name is used as the window.cardano key', async ({ page, wallet }) => {
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText(wallet.name);
  });
});

test.describe('renamed wallet', () => {
  test.use({ walletOptions: { name: 'eternl', displayName: 'Eternl' } });
  test('the demo shows the configured key', async ({ page }) => {
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText('eternl');
  });
});

test.describe('install opt-out', () => {
  test.use({ walletOptions: { install: false } });
  test('nothing is injected into the page, but the handle still describes the wallet', async ({ page, wallet }) => {
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText('none');
    expect(wallet.name).toBe('chw');
    await expect(wallet.calls()).rejects.toThrow(/not installed/);
  });
});
