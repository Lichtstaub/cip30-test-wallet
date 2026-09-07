import { expect, test } from '@playwright/test';
import { runDoctor } from '../src/host/doctor.js';

const base = 'http://localhost:4173';
const ids = (r: Awaited<ReturnType<typeof runDoctor>>) => r.findings.map((f) => f.id);

test.describe('doctor --deep against the demo', () => {
  test('strict: single scan, blocked eval agrees with the policy, page violation observed', async ({ browserName }) => {
    const r = await runDoctor(`${base}/strict/`, { deep: true, browser: browserName });
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

  test('permissive: probe agrees with the policy, no violations', async ({ browserName }) => {
    const r = await runDoctor(`${base}/permissive/`, { deep: true, browser: browserName });
    expect(r.deep!.routeProbe).toBe('ok');
    expect(r.deep!.violations).toEqual([]);
    expect(ids(r)).not.toContain('eval-verdict-mismatch');
  });

  test('hashed: the probe is skipped with a reason instead of breaking the page', async ({ browserName }) => {
    const r = await runDoctor(`${base}/hashed/`, { deep: true, browser: browserName });
    expect(r.deep!.routeProbe).toBe('skipped');
    expect(r.deep!.routeProbeReason).toMatch(/hash/);
    expect(ids(r)).toContain('eval-probe-skipped');
    expect(r.deep!.access.count).toBe(1);
  });

  test('late injection is not detected by the single-scan page and detected with retry', async ({ browserName }) => {
    const missed = await runDoctor(`${base}/strict/`, { deep: true, browser: browserName, injectAfterMs: 800, expect: '#wallet-found' });
    expect(missed.deep!.injection.providerVisible).toBe(true);
    expect(missed.deep!.injection.expectVisible).toBe(false);
    expect(ids(missed)).toContain('wallet-not-detected');

    const found = await runDoctor(`${base}/strict/?retry=1`, { deep: true, browser: browserName, injectAfterMs: 800, expect: '#wallet-found', settleMs: 2500 });
    expect(found.deep!.injection.expectVisible).toBe(true);
    expect(found.deep!.access.count).toBeGreaterThan(1);
    expect(ids(found)).not.toContain('wallet-not-detected');
    expect(ids(found)).not.toContain('single-scan');
  });

  test('a click path runs before the probes are read', async ({ browserName }) => {
    const r = await runDoctor(`${base}/permissive/`, { deep: true, browser: browserName, click: '#connect' });
    expect(r.deep!.access.count).toBeGreaterThanOrEqual(2);
  });
});
