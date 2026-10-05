// The Plutus evaluator stays in Node: the page and the shared core never name
// it, and inside src only the phase 2 module loads it, lazily.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe('the Plutus evaluator', () => {
  it('is named by no file under src/core or src/page', () => {
    const naming = [...files('src/core'), ...files('src/page')].filter((file) => readFileSync(file, 'utf8').includes('scalus'));
    expect(naming).toEqual([]);
  });

  it('is imported only by src/host/checks/phase-two.ts, and there only dynamically', () => {
    const importing = files('src').filter((file) => /['"]scalus['"]/.test(readFileSync(file, 'utf8')));
    expect(importing).toEqual(['src/host/checks/phase-two.ts']);
    const source = readFileSync('src/host/checks/phase-two.ts', 'utf8');
    expect(source).not.toMatch(/\bfrom\s+['"]scalus['"]/);
    expect(source).toContain("await import('scalus')");
  });
});
