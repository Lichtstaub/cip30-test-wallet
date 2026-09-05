import { expect, test } from '@playwright/test';
import { CSP } from '../examples/minimal-dapp/csp.mjs';
import { VARIANTS, appendProbeToFirstPartyScript, url } from './helpers/csp.js';

// Third probe path from the milestone 1b findings: addInitScript and
// page.evaluate bypass CSP in most engines. Appending the probe to the
// page's own script through response interception runs it under the real
// CSP, so it must agree with the page-native verdict everywhere.

for (const variant of VARIANTS) {
  test(`route-appended probe agrees with page-native eval on ${variant}`, async ({ page }) => {
    await appendProbeToFirstPartyScript(page, variant);
    await page.goto(url(variant));
    await expect(page.locator('#eval-result')).not.toHaveText('pending');
    const truth = await page.locator('#eval-result').textContent();
    const probe = await page.evaluate(() => (window as unknown as { __chwRouteProbeEval: string }).__chwRouteProbeEval);
    expect(probe, `route-appended probe on ${variant}`).toBe(truth);
  });
}

test('the intercepted script still carries the CSP header of the document', async ({ page }) => {
  await appendProbeToFirstPartyScript(page, 'strict');
  const response = await page.goto(url('strict'));
  expect(response?.headers()['content-security-policy']).toBe(CSP.strict);
  await expect(page.locator('#eval-result')).toHaveText('blocked');
});
