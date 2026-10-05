import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { PAGE_BUNDLE_MAX_BYTES, PAGE_BUNDLE_OPTIONS } from '../scripts/page-bundle.mjs';
import { runInBareWindow, testConfig } from './helpers/page.js';

describe('page bundle', () => {
  it('builds to a single self-contained script that installs the wallet into a bare window', async () => {
    // Same options as scripts/build.mjs, but write: false, so this test never depends on a
    // prior npm run build and never leaves a stale dist/page.js behind on failure.
    const result = await build({ ...PAGE_BUNDLE_OPTIONS, write: false, logLevel: 'silent' });
    const source = result.outputFiles[0]!.text;
    expect(source).not.toMatch(/\bfrom\s+["']node:/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/WebAssembly/);
    expect(source.length).toBeLessThan(PAGE_BUNDLE_MAX_BYTES);

    const window = runInBareWindow(`${source}\n;__chwInit(${JSON.stringify(testConfig())});`);
    const cardano = window['cardano'] as Record<string, { apiVersion: string }>;
    expect(cardano['chw']!.apiVersion).toBe('1');
    expect(window['__chw']).toBeDefined();
  });

  it('carries none of the ledger checks and no Plutus evaluator, they run in Node only', async () => {
    const source = (await build({ ...PAGE_BUNDLE_OPTIONS, write: false, logLevel: 'silent' })).outputFiles[0]!.text;
    for (const name of ['FeeTooSmallUTxO', 'ValueNotConservedUTxO', 'ConwayApplyTxError', 'tierRefScriptFee', 'ValidationTagMismatch', 'scalus']) expect(source).not.toContain(name);
  });

  it.skipIf(!existsSync('dist/node'))('emits the node entry points the package exports point at', () => {
    expect(existsSync('dist/node/index.js')).toBe(true);
    expect(existsSync('dist/node/index.d.ts')).toBe(true);
    expect(existsSync('dist/node/playwright/index.js')).toBe(true);
  });
});
