import { expect, expectSignedBy, test } from '../src/playwright/index.js';

async function connect(page: import('@playwright/test').Page) {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  await page.locator('#connect').click();
}

test.describe('acceptance: the two tests commitproof cannot write today', () => {
  test('commit flow submits a transaction that really carries the wallet signature', async ({ page, wallet }) => {
    await connect(page);
    await expect(page.locator('#connect-result')).toHaveText('network 0');
    await page.locator('#commit').click();
    await expect(page.locator('#commit-result')).toHaveText(/^submitted [0-9a-f]{64}$/);

    expect(await wallet.calls('signTx')).toHaveLength(1);
    const tx = await wallet.lastSubmittedTx();
    expect(tx).toBeDefined();
    expectSignedBy(tx!, wallet);
    const shown = (await page.locator('#commit-result').textContent())!.replace('submitted ', '');
    const submit = (await wallet.calls('submitTx'))[0]!;
    expect(submit.result).toBe(shown);
  });

  test.describe('wallet on mainnet', () => {
    test.use({ walletOptions: { networkId: 1 } });
    test('the demo shows the human network message instead of building a transaction', async ({ page, wallet }) => {
      await connect(page);
      await expect(page.locator('#connect-result')).toHaveText('wrong network: wallet is on mainnet, this demo expects preprod');
      expect(wallet.addresses.payment.startsWith('addr1')).toBe(true);
      expect(await wallet.calls('signTx')).toHaveLength(0);
    });
  });
});

test.describe('quirks through the fixture', () => {
  test.describe('signRejected', () => {
    test.use({ walletOptions: { quirks: { signRejected: true } } });
    test('the demo reports the decline', async ({ page }) => {
      await connect(page);
      await page.locator('#commit').click();
      await expect(page.locator('#commit-result')).toHaveText('declined');
    });
  });

  test.describe('signHangs', () => {
    test.use({ walletOptions: { quirks: { signHangs: true } } });
    test('the demo waits, and release lets it finish', async ({ page, wallet }) => {
      await connect(page);
      await page.locator('#commit').click();
      await expect(page.locator('#commit-result')).toHaveText('signing');
      await page.waitForTimeout(300);
      await expect(page.locator('#commit-result')).toHaveText('signing');
      await wallet.release('signTx');
      await expect(page.locator('#commit-result')).toHaveText(/^submitted /);
    });

    test('reject ends the wait as a decline', async ({ page, wallet }) => {
      await connect(page);
      await page.locator('#commit').click();
      await expect(page.locator('#commit-result')).toHaveText('signing');
      await wallet.reject('signTx');
      await expect(page.locator('#commit-result')).toHaveText('declined');
    });
  });

  test.describe('enableRejected', () => {
    test.use({ walletOptions: { quirks: { enableRejected: true } } });
    test('the demo reports the refused connection', async ({ page }) => {
      await connect(page);
      await expect(page.locator('#connect-result')).toHaveText('error -3');
    });
  });

  test.describe('lateInjection', () => {
    test.use({ walletOptions: { quirks: { lateInjection: 800 } } });
    test('is missed by the single-scan page and found with retry', async ({ page }) => {
      await page.goto('/strict/');
      await page.waitForTimeout(1200);
      await expect(page.locator('#wallets')).toHaveText('none');
      await page.goto('/strict/?retry=1');
      await expect(page.locator('#wallets')).toHaveText('chw', { timeout: 4000 });
    });
  });

  test('augments an existing window.cardano instead of replacing it', async ({ page }) => {
    // The wallet fixture is auto: true, so its init script always runs first, meaning
    // window.cardano.chw already exists by the time this script runs. A second wallet
    // that follows the CIP-30 convention of checking for an existing window.cardano
    // before writing to it must find chw still there, not wiped out.
    await page.addInitScript(`window.cardano = window.cardano || {}; window.cardano.other = { apiVersion: '1', name: 'Other', icon: '', supportedExtensions: [], isEnabled: () => Promise.resolve(false), enable: () => Promise.resolve({}) };`);
    await page.goto('/strict/');
    await expect(page.locator('#wallets')).toHaveText('chw,other');
  });

  test('setQuirk flips behaviour at runtime', async ({ page, wallet }) => {
    await connect(page);
    await wallet.setQuirk('signRejected', true);
    await page.locator('#commit').click();
    await expect(page.locator('#commit-result')).toHaveText('declined');
  });
});
