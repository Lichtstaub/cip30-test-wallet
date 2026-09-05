import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { testConfig } from './helpers/page.js';

describe('page bundle', () => {
  it('builds to a single self-contained script that installs the wallet into a bare window', () => {
    execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
    expect(existsSync('dist/page.js')).toBe(true);
    const source = readFileSync('dist/page.js', 'utf8');
    expect(source).not.toMatch(/\bfrom\s+["']node:/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/WebAssembly/);
    expect(source.length).toBeLessThan(160 * 1024);

    const window: Record<string, unknown> = {};
    const context = vm.createContext({ window, setTimeout, TextEncoder, TextDecoder, Date, console });
    vm.runInContext(source, context);
    vm.runInContext(`__chwInit(${JSON.stringify(testConfig())})`, context);
    const cardano = window['cardano'] as Record<string, { apiVersion: string }>;
    expect(cardano['chw']!.apiVersion).toBe('1');
    expect(window['__chw']).toBeDefined();
  });

  it('emits the node entry points the package exports point at', () => {
    expect(existsSync('dist/node/index.js')).toBe(true);
    expect(existsSync('dist/node/index.d.ts')).toBe(true);
    expect(existsSync('dist/node/playwright/index.js')).toBe(true);
  });
});
