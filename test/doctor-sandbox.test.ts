import { beforeEach, describe, expect, it, vi } from 'vitest';

// No real browser starts here. @playwright/test is replaced by a chromium whose launch
// or newContext fails the way Playwright reports a browser that aborted at start, and
// doctor-probes.js by harmless stubs so the deep run reaches the launch. Plain functions
// instead of vi.fn, a rejecting spy made vitest 5 fail the test.
let launchCalls = 0;
let launchImpl: () => Promise<unknown> = async () => {
  throw new Error('launchImpl not set');
};

vi.mock('@playwright/test', () => ({
  chromium: {
    launch: () => {
      launchCalls++;
      return launchImpl();
    },
  },
}));
vi.mock('../src/host/doctor-probes.js', () => ({ OBSERVE_SCRIPT: '', ROUTE_PROBE: '', injectScript: () => '' }));

const { runDoctor, explainStartupFailure, sandboxPreflight } = await import('../src/host/doctor.js');

const CLOSED = 'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n<launching> chrome-headless-shell';
const fetchImpl = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const mac = { platform: 'darwin' as const, env: {} };
const rejectClosed = async () => {
  throw new Error(CLOSED);
};

describe('doctor --deep inside an agent sandbox', () => {
  beforeEach(() => {
    launchCalls = 0;
  });

  it('starts no browser in the Codex sandbox on macOS and names the cause and the fix', async () => {
    const r = await runDoctor('http://x.example/', { deep: true, fetchImpl, platform: 'darwin', env: { CODEX_SANDBOX: 'seatbelt' } });
    expect(launchCalls).toBe(0);
    expect(r.deep).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^deep run skipped: no browser was started/);
    expect(r.errors[0]).toContain('CODEX_SANDBOX=seatbelt');
    expect(r.errors[0]).toContain('outside the sandbox');
  });

  it('adds the likely cause after the Playwright message when a launch aborts on macOS', async () => {
    launchImpl = rejectClosed;
    const r = await runDoctor('http://x.example/', { deep: true, fetchImpl, ...mac });
    expect(launchCalls).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.startsWith(`deep run failed: ${CLOSED} On macOS`)).toBe(true);
    expect(r.errors[0]).toContain('window server');
    expect(r.errors[0]).toContain('outside the sandbox');
  });

  it('explains a browser that launches but closes before the first context', async () => {
    const close = vi.fn(async () => {});
    launchImpl = async () => ({
      newContext: async () => {
        throw new Error('browser.newContext: Target page, context or browser has been closed');
      },
      close,
    });
    const r = await runDoctor('http://x.example/', { deep: true, fetchImpl, platform: 'darwin', env: { SANDBOX_RUNTIME: '1' } });
    expect(r.errors[0]).toMatch(/^deep run failed: the browser closed right after it started, likely because the Claude Code sandbox \(SANDBOX_RUNTIME=1\)/);
    expect(r.errors[0]).toContain('Playwright reported: browser.newContext: Target page');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a failure after startup as Playwright worded it', async () => {
    const closed = 'context.newPage: Target page, context or browser has been closed';
    launchImpl = async () => ({
      newContext: async () => ({
        newPage: async () => {
          throw new Error(closed);
        },
        close: async () => {},
      }),
      close: async () => {},
    });
    const r = await runDoctor('http://x.example/', { deep: true, fetchImpl, ...mac });
    expect(r.errors).toEqual([`deep run failed: ${closed}`]);
  });

  it('leaves the raw launch error alone off macOS', async () => {
    launchImpl = rejectClosed;
    const r = await runDoctor('http://x.example/', { deep: true, fetchImpl, platform: 'linux', env: { CODEX_SANDBOX: 'seatbelt' } });
    expect(launchCalls).toBe(1);
    expect(r.errors).toEqual([`deep run failed: ${CLOSED}`]);
  });
});

describe('sandboxPreflight', () => {
  it('refuses only on macOS with CODEX_SANDBOX=seatbelt', () => {
    expect(sandboxPreflight({ platform: 'darwin', env: { CODEX_SANDBOX: 'seatbelt' } })).not.toBeNull();
    expect(sandboxPreflight({ platform: 'linux', env: { CODEX_SANDBOX: 'seatbelt' } })).toBeNull();
    expect(sandboxPreflight({ platform: 'darwin', env: {} })).toBeNull();
    expect(sandboxPreflight({ platform: 'darwin', env: { SANDBOX_RUNTIME: '1' } })).toBeNull();
  });
});

describe('explainStartupFailure', () => {
  it('leads with a known sandbox and keeps the raw message', () => {
    const text = explainStartupFailure(CLOSED, { platform: 'darwin', env: { SANDBOX_RUNTIME: '1' } });
    expect(text).toMatch(/^the browser closed right after it started, likely because the Claude Code sandbox/);
    expect(text.endsWith(`Playwright reported: ${CLOSED}`)).toBe(true);
  });

  it('keeps the raw message first and names a generic agent sandbox when no known variable is set', () => {
    const text = explainStartupFailure(CLOSED, mac);
    expect(text.startsWith(CLOSED)).toBe(true);
    expect(text).toContain('such as a coding agent sandbox');
  });

  it('leaves the message alone off macOS', () => {
    expect(explainStartupFailure(CLOSED, { platform: 'linux', env: { SANDBOX_RUNTIME: '1' } })).toBe(CLOSED);
  });
});
