import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli/doctor.js';
import { resolveWalletOptions, runInitScript } from '../src/cli/init-script.js';
import { runInBareWindow } from './helpers/page.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'chw-init-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('init-script arguments', () => {
  it('parses every flag', () => {
    expect(parseArgs(['init-script', '--options', 'w.json', '--network', '1', '--name', 'eternl', '--mnemonic-env', 'E2E_MNEMONIC', '--out', 'w.js'])).toEqual({
      command: 'init-script',
      args: { optionsFile: 'w.json', networkId: 1, name: 'eternl', mnemonicEnv: 'E2E_MNEMONIC', out: 'w.js' },
    });
    expect(parseArgs(['init-script'])).toEqual({ command: 'init-script', args: {} });
  });

  it('rejects unknown flags, missing values and bad networks', () => {
    expect(parseArgs(['init-script', '--bogus'])).toMatchObject({ command: 'error', message: 'unknown flag --bogus' });
    expect(parseArgs(['init-script', '--out'])).toMatchObject({ command: 'error', message: '--out needs a value' });
    expect(parseArgs(['init-script', '--network', '2'])).toMatchObject({ command: 'error' });
  });
});

describe('resolveWalletOptions', () => {
  it('reads the options file and lets flags override it', () => {
    withTempDir((dir) => {
      const file = join(dir, 'w.json');
      writeFileSync(file, JSON.stringify({ networkId: 0, name: 'nami', quirks: { signRejected: true } }));
      expect(resolveWalletOptions({ optionsFile: file, networkId: 1 }, {})).toEqual({ networkId: 1, name: 'nami', quirks: { signRejected: true } });
    });
  });

  it('refuses an options file that is not a JSON object', () => {
    withTempDir((dir) => {
      const file = join(dir, 'w.json');
      writeFileSync(file, '[]');
      expect(() => resolveWalletOptions({ optionsFile: file }, {})).toThrow(/JSON object/);
    });
  });

  it('takes the mnemonic from the named environment variable', () => {
    expect(resolveWalletOptions({ mnemonicEnv: 'E2E_MNEMONIC' }, { E2E_MNEMONIC: MNEMONIC })).toEqual({ mnemonic: MNEMONIC });
    expect(() => resolveWalletOptions({ mnemonicEnv: 'E2E_MNEMONIC' }, {})).toThrow(/E2E_MNEMONIC is empty or not set/);
  });
});

describe('init-script options', () => {
  it('refuses install: false, a script that installs nothing would pass silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chw-init-'));
    try {
      const file = join(dir, 'w.json');
      writeFileSync(file, JSON.stringify({ install: false }));
      expect(() => runInitScript({ optionsFile: file }, {})).toThrow(/install: false/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!existsSync('dist/page.js'))('init-script output', () => {
  it('installs the configured wallet when evaluated in a bare window', () => {
    const script = runInitScript({ networkId: 1, name: 'eternl' }, {})!;
    const window = runInBareWindow(script);
    const cardano = window['cardano'] as Record<string, { apiVersion: string }>;
    expect(cardano['eternl']!.apiVersion).toBe('1');
    expect(window['__chw']).toBeDefined();
  });

  it('writes to --out instead of returning the script', () => {
    withTempDir((dir) => {
      const out = join(dir, 'wallet.js');
      expect(runInitScript({ out }, {})).toBeUndefined();
      expect(readFileSync(out, 'utf8')).toContain('__chwInit(');
    });
  });

  it('prints the script through main and exits 0', async () => {
    const out: string[] = [];
    const code = await main(['init-script'], { out: (s) => out.push(s), err: () => {} });
    expect(code).toBe(0);
    expect(out.join('')).toContain('__chwInit(');
  });

  it.skipIf(!existsSync('dist/node/cli/doctor.js'))('prints the whole script into a pipe, past the 64 KB pipe buffer', () => {
    const piped = execFileSync(process.execPath, ['dist/node/cli/doctor.js', 'init-script'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(piped.length).toBeGreaterThan(65536);
    expect(piped.trimEnd().endsWith('});')).toBe(true);
  });
});
