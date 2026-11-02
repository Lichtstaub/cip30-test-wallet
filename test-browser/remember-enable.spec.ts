import { expect, test } from '../src/playwright/index.js';
import type { Page } from '@playwright/test';

type ChwWindow = { cardano: Record<string, { isEnabled(): Promise<boolean> }> };

const isEnabled = (page: Page) => page.evaluate(() => (window as unknown as ChwWindow).cardano['chw']!.isEnabled());

async function connect(page: Page): Promise<void> {
  await page.goto('/permissive/');
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
}

test.describe('rememberEnable', () => {
  test.use({ walletOptions: { rememberEnable: true } });

  test('a reload and a navigation on the same origin keep the grant, which lives in Node and not in page storage', async ({ page, wallet }) => {
    await connect(page);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.reload();
    expect(await isEnabled(page)).toBe(true);
    await page.goto('/strict/');
    expect(await isEnabled(page)).toBe(true);
    expect(await wallet.calls('isEnabled')).toHaveLength(1);
  });

  test('a new test starts without a grant', async ({ page }) => {
    await page.goto('/permissive/');
    expect(await isEnabled(page)).toBe(false);
  });
});

test.describe('without rememberEnable', () => {
  test('a reload forgets enable()', async ({ page }) => {
    await connect(page);
    expect(await isEnabled(page)).toBe(true);
    await page.reload();
    expect(await isEnabled(page)).toBe(false);
  });
});
