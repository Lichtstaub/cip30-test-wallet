// Two outputs: dist/node (tsc, ESM plus declarations, everything Node needs)
// and dist/page.js (esbuild, one IIFE for the page). The page bundle must
// stand alone, the check in bundle-check.mjs enforces that.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

await build({
  entryPoints: ['src/page/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/page.js',
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});
