import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../examples/minimal-dapp/serve.mjs';
import { exitCode, formatHuman, formatJson } from '../src/checks/report.js';
import { runDoctor } from '../src/host/doctor.js';
import { findingIds as ids } from './helpers/doctor.js';

let base = '';
const server = createDemoServer();

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('runDoctor, static', () => {
  it('flags blocked eval on the strict variant and exits 1', async () => {
    const r = await runDoctor(`${base}/strict/`);
    expect(r.finalUrl).toBe(`${base}/strict/`);
    expect(r.secureContext).toBe(true);
    expect(r.evalAllowed).toBe(false);
    expect(ids(r)).toContain('eval-blocked');
    expect(exitCode(r)).toBe(1);
    const eval1 = r.findings.find((f) => f.id === 'eval-blocked')!;
    expect(eval1.severity).toBe('warning');
    expect(eval1.detail).toMatch(/Eternl/);
    expect(eval1.detail).not.toMatch(/add 'unsafe-eval'/i);
  });

  it('is clean on the permissive variant and exits 0', async () => {
    const r = await runDoctor(`${base}/permissive/`);
    expect(r.evalAllowed).toBe(true);
    expect(ids(r)).not.toContain('eval-blocked');
    expect(exitCode(r)).toBe(0);
  });

  it('reads a meta policy', async () => {
    const r = await runDoctor(`${base}/meta-strict/`);
    expect(r.policies.map((p) => p.source)).toEqual(['meta']);
    expect(ids(r)).toContain('eval-blocked');
  });

  it('treats report-only as not blocking and says so', async () => {
    const r = await runDoctor(`${base}/report-only/`);
    expect(r.evalAllowed).toBe(true);
    expect(ids(r)).toContain('report-only-csp');
    expect(ids(r)).toContain('no-enforced-csp');
    expect(exitCode(r)).toBe(0);
  });

  it('follows a redirect and evaluates the final url', async () => {
    const r = await runDoctor(`${base}/strict`);
    expect(r.finalUrl).toBe(`${base}/strict/`);
  });

  it('reports a plain http host as no secure context', async () => {
    const r = await runDoctor('http://example.invalid/', {
      fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(r.secureContext).toBe(false);
    expect(ids(r)).toContain('no-secure-context');
    expect(r.findings.find((f) => f.id === 'no-secure-context')!.severity).toBe('error');
  });

  it('exits 2 when the url cannot be fetched', async () => {
    const r = await runDoctor(`http://127.0.0.1:1/`);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(exitCode(r)).toBe(2);
  });

  it('reports a non-2xx status as an error finding and exits 1', async () => {
    const r = await runDoctor('http://example.invalid/', {
      fetchImpl: async () => new Response('<html></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    });
    expect(r.status).toBe(403);
    expect(ids(r)).toContain('http-status');
    expect(r.findings.find((f) => f.id === 'http-status')!.severity).toBe('error');
    expect(exitCode(r)).toBe(1);
  });

  it('reports a non-html content type as a warning finding', async () => {
    const r = await runDoctor('http://example.invalid/', {
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    expect(r.contentType).toBe('application/json');
    expect(ids(r)).toContain('not-html');
    expect(r.findings.find((f) => f.id === 'not-html')!.severity).toBe('warning');
  });

  it('passes an aborting signal built from the configured timeout to fetchImpl', async () => {
    let capturedSignal: unknown;
    await runDoctor(`${base}/strict/`, {
      timeoutMs: 50,
      fetchImpl: async (input, init) => {
        capturedSignal = init?.signal;
        return fetch(input, init);
      },
    });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('formatters', () => {
  it('human output names every finding with its severity, json round-trips', async () => {
    const r = await runDoctor(`${base}/strict/`);
    const text = formatHuman(r);
    expect(text).toContain('[warning] eval-blocked');
    expect(text).toContain(r.finalUrl!);
    expect(JSON.parse(formatJson(r)).findings.map((f: { id: string }) => f.id)).toEqual(ids(r));
  });
});
