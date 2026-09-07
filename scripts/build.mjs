// Two outputs: dist/node (tsc, ESM plus declarations, everything Node needs)
// and dist/page.js (esbuild, one IIFE for the page). The page bundle must
// stand alone, the check in bundle-check.mjs enforces that. tsc and esbuild
// run concurrently, tsc output is only printed if it fails.
import { execFile } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { PAGE_BUNDLE_OPTIONS } from './page-bundle.mjs';

const execFileAsync = promisify(execFile);

rmSync('dist', { recursive: true, force: true });

const tsc = execFileAsync('npx', ['tsc', '-p', 'tsconfig.build.json']).catch((error) => {
  process.stdout.write(error.stdout ?? '');
  process.stderr.write(error.stderr ?? '');
  throw new Error('tsc failed');
});

await Promise.all([tsc, build({ ...PAGE_BUNDLE_OPTIONS, outfile: 'dist/page.js', logLevel: 'info' })]);

// tsc keeps the shebang line, make the CLI entry executable for npx.
chmodSync('dist/node/cli/doctor.js', 0o755);
