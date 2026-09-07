import { afterEach, describe, expect, it, vi } from 'vitest';

// A static run must never load doctor-probes.js: that module pulls in the wallet
// bundle, key derivation and Evolution, none of which a static fetch-and-parse
// run needs. Both dependencies are mocked to throw so the test stays a fast unit
// test: doctor-probes.js because we want to know whether it was imported at all,
// @playwright/test because deep runs must fail fast here instead of launching a
// real browser.
let probesFactoryCalled = false;

vi.mock('../src/host/doctor-probes.js', () => {
  probesFactoryCalled = true;
  throw new Error('doctor-probes.js must not be imported here');
});

vi.mock('@playwright/test', () => {
  throw new Error('@playwright/test is not available in this test');
});

describe('doctor.ts loads doctor-probes.js lazily', () => {
  afterEach(() => {
    probesFactoryCalled = false;
  });

  it('does not import doctor-probes.js for a static run', async () => {
    const { runDoctor } = await import('../src/host/doctor.js');
    const r = await runDoctor('http://x.example/', {
      fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(r.errors).toEqual([]);
    expect(probesFactoryCalled).toBe(false);
  });

  it('imports doctor-probes.js for a deep run, which then fails fast because Playwright is unavailable here', async () => {
    const { runDoctor } = await import('../src/host/doctor.js');
    const r = await runDoctor('http://x.example/', {
      deep: true,
      fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(probesFactoryCalled).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
