import { expect, test } from '@playwright/test';
import { url, walletStub } from './helpers/csp.js';

test.describe('criterion 3: an injected wallet appears under strict CSP', () => {
  test('the stub is listed and enable() works', async ({ page }) => {
    await page.addInitScript(walletStub());
    await page.goto(url('strict'));
    await expect(page.locator('#wallets')).toHaveText('chw');
    await page.locator('#connect').click();
    await expect(page.locator('#connect-result')).toHaveText('network 0');
  });

  test('the page-native eval is still blocked, so the wallet did not need eval', async ({ page }) => {
    await page.addInitScript(walletStub());
    await page.goto(url('strict'));
    await expect(page.locator('#eval-result')).toHaveText('blocked');
    await expect(page.locator('#wallets')).toHaveText('chw');
  });

  test('augments an existing window.cardano instead of overwriting it', async ({ page }) => {
    await page.addInitScript(`
      window.cardano = window.cardano || {};
      window.cardano.other = {
        apiVersion: '1', name: 'other', icon: '', supportedExtensions: [],
        isEnabled: () => Promise.resolve(false),
        enable: () => Promise.resolve({ getNetworkId: () => Promise.resolve(0) }),
      };
    `);
    await page.addInitScript(walletStub());
    await page.goto(url('strict'));
    await expect(page.locator('#wallets')).toHaveText('other,chw');
  });
});

test.describe('criterion 4: late injection is only found by a dApp that retries', () => {
  test('without retry the single scan misses a wallet injected after 800 ms', async ({ page }) => {
    await page.addInitScript(walletStub(800));
    await page.goto(url('strict'));
    await expect(page.locator('#wallets')).toHaveText('none');
    // Wait past the injection and confirm the page never looked again.
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => Boolean((window as unknown as { cardano?: unknown }).cardano))).toBe(true);
    await expect(page.locator('#wallets')).toHaveText('none');
    await expect(page.locator('#scan-count')).toHaveText('1');
  });

  test('with retry the wallet injected after 800 ms is found', async ({ page }) => {
    await page.addInitScript(walletStub(800));
    await page.goto(url('strict', 'retry=1'));
    await expect(page.locator('#wallets')).toHaveText('chw', { timeout: 4000 });
    const scans = Number(await page.locator('#scan-count').textContent());
    expect(scans).toBeGreaterThan(1);
  });
});
