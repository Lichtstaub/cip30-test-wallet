import { expect, test } from '@playwright/test';
import { EVAL_PROBE, VARIANTS, url } from './helpers/csp.js';

// Two injection paths doctor could use. Each must agree with the page's own
// verdict on both variants. If a path sees "ok" where the page sees
// "blocked", that path bypasses CSP and is useless as a probe.

for (const variant of VARIANTS) {
  test.describe(`criterion 2 on ${variant}`, () => {
    test('addInitScript probe agrees with page-native eval', async ({ page, browserName }) => {
      test.fixme(
        variant === 'strict' && (browserName === 'chromium' || browserName === 'firefox'),
        'Chromium and Firefox report ok from the addInitScript probe under the strict CSP where the page itself reports blocked'
      );
      await page.addInitScript(EVAL_PROBE);
      await page.goto(url(variant));
      const truth = await page.locator('#eval-result').textContent();
      const probe = await page.evaluate(() => (window as unknown as { __chwProbeEval: string }).__chwProbeEval);
      expect(probe, `addInitScript probe on ${variant}`).toBe(truth);
    });

    if (variant === 'strict') {
      test('documents the CSP bypass of addInitScript probe in this engine', async ({ page, browserName }) => {
        test.skip(browserName === 'webkit', 'WebKit enforces CSP on addInitScript code, this engine has no bypass to pin');
        await page.addInitScript(EVAL_PROBE);
        await page.goto(url(variant));
        await expect(page.locator('#eval-result')).toHaveText('blocked');
        const probe = await page.evaluate(() => (window as unknown as { __chwProbeEval: string }).__chwProbeEval);
        expect(probe).toBe('ok');
      });
    }

    test('page.evaluate probe agrees with page-native eval', async ({ page }) => {
      test.fixme(
        variant === 'strict',
        'Chromium, Firefox and WebKit all report ok from the page.evaluate probe under the strict CSP where the page itself reports blocked'
      );
      await page.goto(url(variant));
      const truth = await page.locator('#eval-result').textContent();
      const probe = await page.evaluate(() => {
        try {
          new Function('return 1')();
          return 'ok';
        } catch {
          return 'blocked';
        }
      });
      expect(probe, `page.evaluate probe on ${variant}`).toBe(truth);
    });

    if (variant === 'strict') {
      test('documents the CSP bypass of page.evaluate probe in this engine', async ({ page }) => {
        await page.goto(url(variant));
        await expect(page.locator('#eval-result')).toHaveText('blocked');
        const probe = await page.evaluate(() => {
          try {
            new Function('return 1')();
            return 'ok';
          } catch {
            return 'blocked';
          }
        });
        expect(probe).toBe('ok');
      });
    }

    test('a securitypolicyviolation event is observable from an init script', async ({ page }) => {
      await page.addInitScript(`
        window.__chwViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__chwViolations.push(e.violatedDirective + ':' + e.blockedURI);
        });
      `);
      await page.goto(url(variant));
      await expect(page.locator('#eval-result')).not.toHaveText('pending');
      const violations = await page.evaluate(() => (window as unknown as { __chwViolations: string[] }).__chwViolations);
      // The automatic favicon.ico request falls back to default-src 'none' in both
      // variants and Firefox alone reports it as an img-src violation, unrelated
      // to eval. Filter both branches to script-src so that quirk cannot affect
      // either assertion.
      const scriptSrcViolations = violations.filter((v) => v.startsWith('script-src'));
      if (variant === 'strict') expect(scriptSrcViolations).toContain('script-src:eval');
      else expect(scriptSrcViolations).toEqual([]);
    });
  });
}
