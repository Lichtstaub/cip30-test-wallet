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

  test('wallet.revoke() forgets the grant, a reload is not enabled', async ({ page, wallet }) => {
    await connect(page);
    await wallet.revoke();
    expect(await isEnabled(page)).toBe(false);
    await page.reload();
    expect(await isEnabled(page)).toBe(false);
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

test.describe('revoke', () => {
  test('wallet.revoke() ends an api enabled in a same-origin iframe', async ({ page, wallet }) => {
    // A small route on the demo origin without a CSP, the demo variants do not allow framing.
    await page.route('**/frames/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: route.request().url().endsWith('/outer') ? '<!doctype html><iframe name="inner" src="/frames/inner"></iframe>' : '<!doctype html><title>inner</title>',
      }),
    );
    await page.goto('/frames/outer');
    const inner = page.frame({ name: 'inner' })!;
    await inner.waitForFunction(() => (window as unknown as { cardano?: Record<string, unknown> }).cardano?.['chw'] !== undefined);
    type ApiWindow = { cardano: Record<string, { enable(): Promise<{ getNetworkId(): Promise<number> }> }>; api?: { getNetworkId(): Promise<number> } };
    expect(
      await inner.evaluate(async () => {
        const w = window as unknown as ApiWindow;
        w.api = await w.cardano['chw']!.enable();
        return w.api.getNetworkId();
      }),
    ).toBe(0);
    await wallet.revoke();
    const error = await inner.evaluate(() => (window as unknown as ApiWindow).api!.getNetworkId().then(() => undefined, (e: unknown) => e));
    expect(error).toEqual({ code: -3, info: 'the wallet revoked the connection' });
  });
});
