import { expect, test } from '@playwright/test';
import { runDoctor } from '../src/host/doctor.js';
import { findingIds as ids } from '../test/helpers/doctor.js';

const base = 'http://localhost:4173';

test.describe('doctor --deep against the demo', () => {
  test('strict: single scan, blocked eval agrees with the policy, page violation observed', async ({ browser, browserName }) => {
    const r = await runDoctor(`${base}/strict/`, { deep: true, browser: browserName, browserImpl: browser });
    expect(r.errors).toEqual([]);
    expect(r.deep!.access.count).toBe(1);
    expect(r.deep!.access.firstAccessMs).toBeGreaterThan(50);
    expect(r.deep!.routeProbe).toBe('blocked');
    expect(r.deep!.violations.some((v) => v.startsWith('script-src:eval'))).toBe(true);
    expect(ids(r)).toContain('single-scan');
    expect(ids(r)).toContain('eval-blocked');
    expect(ids(r)).not.toContain('eval-verdict-mismatch');
    expect(r.deep!.injection.providerVisible).toBe(true);
  });

  test('permissive: probe agrees with the policy, no violations', async ({ browser, browserName }) => {
    const r = await runDoctor(`${base}/permissive/`, { deep: true, browser: browserName, browserImpl: browser });
    expect(r.deep!.routeProbe).toBe('ok');
    expect(r.deep!.violations).toEqual([]);
    expect(ids(r)).not.toContain('eval-verdict-mismatch');
  });

  test('hashed: the probe is skipped with a reason instead of breaking the page', async ({ browser, browserName }) => {
    const r = await runDoctor(`${base}/hashed/`, { deep: true, browser: browserName, browserImpl: browser });
    expect(r.deep!.routeProbe).toBe('skipped');
    expect(r.deep!.routeProbeReason).toMatch(/hash/);
    expect(ids(r)).toContain('eval-probe-skipped');
    expect(r.deep!.access.count).toBe(1);
  });

  test('late injection is not detected by the single-scan page and detected with retry', async ({ browser, browserName }) => {
    const missed = await runDoctor(`${base}/strict/`, { deep: true, browser: browserName, browserImpl: browser, injectAfterMs: 800, expect: '#wallet-found' });
    expect(missed.deep!.injection.providerVisible).toBe(true);
    expect(missed.deep!.injection.expectVisible).toBe(false);
    expect(missed.deep!.injection.accessesAfterInjection).toBe(0);
    expect(missed.deep!.injection.injectedAtMs).toBeGreaterThanOrEqual(800);
    expect(ids(missed)).toContain('wallet-not-detected');

    const found = await runDoctor(`${base}/strict/?retry=1`, { deep: true, browser: browserName, browserImpl: browser, injectAfterMs: 800, expect: '#wallet-found', settleMs: 2500 });
    expect(found.deep!.injection.expectVisible).toBe(true);
    expect(found.deep!.injection.accessesAfterInjection).toBeGreaterThan(0);
    expect(found.deep!.access.count).toBeGreaterThan(1);
    expect(ids(found)).not.toContain('wallet-not-detected');
    expect(ids(found)).not.toContain('single-scan');
  });

  test('a click path runs before the probes are read', async ({ browser, browserName }) => {
    const r = await runDoctor(`${base}/permissive/`, { deep: true, browser: browserName, browserImpl: browser, click: '#connect' });
    expect(r.deep!.access.count).toBeGreaterThanOrEqual(2);
  });

  test('--settle bounds how long the expect wait runs against a scan delayed past it', async ({ browser, browserName }) => {
    const tooShort = await runDoctor(`${base}/strict/?delay=2000`, {
      deep: true,
      browser: browserName,
      browserImpl: browser,
      injectAfterMs: 0,
      expect: '#wallet-found',
      settleMs: 1000,
    });
    expect(tooShort.deep!.injection.expectVisible).toBe(false);
    const notDetected = tooShort.findings.find((f) => f.id === 'wallet-not-detected');
    expect(notDetected).toBeDefined();
    expect(notDetected!.title).toContain('within 1000 ms');

    const longEnough = await runDoctor(`${base}/strict/?delay=2000`, {
      deep: true,
      browser: browserName,
      browserImpl: browser,
      injectAfterMs: 0,
      expect: '#wallet-found',
      settleMs: 3000,
    });
    expect(longEnough.deep!.injection.expectVisible).toBe(true);
  });

  test('status-403: the page still loads and deep facts fill in, http-status is reported', async ({ browser, browserName }) => {
    const r = await runDoctor(`${base}/status-403/`, { deep: true, browser: browserName, browserImpl: browser });
    expect(r.status).toBe(403);
    expect(ids(r)).toContain('http-status');
    expect(r.deep).not.toBeNull();
    expect(typeof r.deep!.access.count).toBe('number');
    expect(r.deep!.injection.providerVisible).toBe(true);
  });

  test('a bad click selector is reported as a finding and the deep facts still fill in', async ({ browser, browserName }) => {
    test.slow();
    const r = await runDoctor(`${base}/permissive/`, { deep: true, browser: browserName, browserImpl: browser, click: '#does-not-exist' });
    expect(ids(r)).toContain('click-failed');
    expect(r.deep).not.toBeNull();
    expect(typeof r.deep!.access.count).toBe('number');
  });
});
