import { expect, test } from '@playwright/test';
import { CSP } from '../examples/minimal-dapp/csp.mjs';
import { url } from './helpers/csp.js';

test.describe('criterion 1: page-native eval is the ground truth', () => {
  test('strict CSP blocks new Function in page code', async ({ page }) => {
    await page.goto(url('strict'));
    await expect(page.locator('#eval-result')).toHaveText('blocked');
  });

  test('permissive CSP allows new Function in page code', async ({ page }) => {
    await page.goto(url('permissive'));
    await expect(page.locator('#eval-result')).toHaveText('ok');
  });

  test('the CSP header is actually delivered', async ({ page }) => {
    const response = await page.goto(url('strict'));
    expect(response?.headers()['content-security-policy']).toBe(CSP.strict);
  });
});
