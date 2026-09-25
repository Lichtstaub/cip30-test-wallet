import { enterpriseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { expect, expectSignedData, test } from '../src/playwright/index.js';

const payloadHex = (text: string) => bytesToHex(new TextEncoder().encode(text));

const openDemo = async (page: import('@playwright/test').Page) => {
  await page.goto('/strict/');
  await expect(page.locator('#wallet-found')).toBeVisible();
};

test.describe('signData in the page', () => {
  test('a message signed with the reward address verifies', async ({ page, wallet }) => {
    await openDemo(page);
    await page.locator('#sign-message').click();
    await expect(page.locator('#sign-message-result')).toHaveText(/^signed /);
    const [call] = await wallet.calls('signData');
    expectSignedData(call!.result as { signature: string; key: string }, { payload: payloadHex('demo message'), address: call!.args[0] as string, publicKeyHex: wallet.stakePublicKeyHex });
  });
});

for (const [quirk, expectedCalls] of [[undefined, 1], ['bareOnly', 1], ['type6Only', 2]] as const) {
  test.describe(`DRep login with cip95SignData ${quirk ?? 'default'}`, () => {
    test.use({ walletOptions: { quirks: quirk ? { cip95SignData: quirk } : {} } });
    test('ends with a verified DRep signature', async ({ page, wallet }) => {
      await page.exposeFunction('__demoDrepCandidates', () => [wallet.drepKeyHashHex, bytesToHex(enterpriseAddressBytes(0, hexToBytes(wallet.drepKeyHashHex)))]);
      await openDemo(page);
      await page.locator('#drep-login').click();
      await expect(page.locator('#drep-login-result')).toHaveText('signed');
      const calls = await wallet.calls('cip95.signData');
      expect(calls).toHaveLength(expectedCalls);
      const last = calls[calls.length - 1]!;
      expectSignedData(last.result as { signature: string; key: string }, { payload: payloadHex('drep login'), address: last.args[0] as string, publicKeyHex: wallet.drepPublicKeyHex });
    });
  });
}

test.describe('DRep login without CIP-95', () => {
  test.use({ walletOptions: { quirks: { noCip95: true } } });
  test('the demo reports the missing namespace and nothing is signed', async ({ page, wallet }) => {
    await page.exposeFunction('__demoDrepCandidates', () => []);
    await openDemo(page);
    await page.locator('#drep-login').click();
    await expect(page.locator('#drep-login-result')).toHaveText('error no-cip95');
    expect(await wallet.calls('cip95.signData')).toHaveLength(0);
  });
});
