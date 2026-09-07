import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageConfig } from '../page/config.js';

let cached: string | undefined;

/** Walks up from this module to the package root and reads dist/page.js. */
export function pageBundle(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const file = join(dir, 'dist', 'page.js');
      if (!existsSync(file)) throw new Error(`page bundle missing at ${file}, run npm run build first`);
      cached = readFileSync(file, 'utf8');
      return cached;
    }
    dir = dirname(dir);
  }
  throw new Error('could not locate the package root from ' + import.meta.url);
}

/** The page bundle followed by an arbitrary snippet, separated so a leading `(` in the snippet cannot be read as a call on the bundle. */
export function bundleWith(code: string): string {
  return `${pageBundle()}\n;${code}`;
}

/** The complete init script: bundle plus the call that installs this config. */
export function initScript(config: PageConfig): string {
  return bundleWith(`globalThis.__chwInit(${JSON.stringify(config)});`);
}
