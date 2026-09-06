import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { PAGE_BUNDLE_MAX_BYTES } from '../scripts/bundle-limits.mjs';
import { testConfig } from './helpers/page.js';

describe('page bundle', () => {
  it('builds to a single self-contained script that installs the wallet into a bare window', async () => {
    // Same options as scripts/build.mjs, but write: false, so this test never depends on a
    // prior npm run build and never leaves a stale dist/page.js behind on failure.
    const result = await build({
      entryPoints: ['src/page/index.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      minify: false,
      legalComments: 'none',
      logLevel: 'silent',
    });
    const source = result.outputFiles[0]!.text;
    expect(source).not.toMatch(/\bfrom\s+["']node:/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/WebAssembly/);
    expect(source.length).toBeLessThan(PAGE_BUNDLE_MAX_BYTES);

    const window: Record<string, unknown> = {};
    const context = vm.createContext({ window, setTimeout, TextEncoder, TextDecoder, Date, console });
    vm.runInContext(source, context);
    vm.runInContext(`__chwInit(${JSON.stringify(testConfig())})`, context);
    const cardano = window['cardano'] as Record<string, { apiVersion: string }>;
    expect(cardano['chw']!.apiVersion).toBe('1');
    expect(window['__chw']).toBeDefined();
  });

  it.skipIf(!existsSync('dist/node'))('emits the node entry points the package exports point at', () => {
    expect(existsSync('dist/node/index.js')).toBe(true);
    expect(existsSync('dist/node/index.d.ts')).toBe(true);
    expect(existsSync('dist/node/playwright/index.js')).toBe(true);
  });
});
