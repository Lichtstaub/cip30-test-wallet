import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli/doctor.js';

describe('parseArgs', () => {
  it('parses the doctor command with flags', () => {
    const r = parseArgs(['doctor', 'https://commitproof.com', '--deep', '--json', '--browser', 'webkit', '--click', '#connect', '--expect', '#wallet-found', '--inject-after', '800']);
    expect(r).toEqual({
      command: 'doctor',
      url: 'https://commitproof.com',
      json: true,
      options: { deep: true, browser: 'webkit', click: '#connect', expect: '#wallet-found', injectAfterMs: 800 },
    });
  });

  it('defaults to a static human run', () => {
    expect(parseArgs(['doctor', 'https://x.example/'])).toEqual({ command: 'doctor', url: 'https://x.example/', json: false, options: {} });
  });

  it('rejects unknown flags, bad browsers and missing urls', () => {
    expect(parseArgs(['doctor'])).toMatchObject({ command: 'error' });
    expect(parseArgs(['doctor', 'https://x.example/', '--bogus'])).toMatchObject({ command: 'error' });
    expect(parseArgs(['doctor', 'https://x.example/', '--browser', 'edge'])).toMatchObject({ command: 'error' });
    expect(parseArgs(['doctor', 'not a url'])).toMatchObject({ command: 'error' });
    expect(parseArgs([])).toEqual({ command: 'help' });
    expect(parseArgs(['--help'])).toEqual({ command: 'help' });
  });

  it('rejects a url that is not http or https', () => {
    expect(parseArgs(['doctor', 'mailto:x'])).toMatchObject({ command: 'error', message: expect.stringMatching(/not a http or https url/) });
  });

  it('parses --timeout and --settle into the options', () => {
    const r = parseArgs(['doctor', 'https://x.example/', '--timeout', '5000', '--settle', '2500']);
    expect(r).toEqual({ command: 'doctor', url: 'https://x.example/', json: false, options: { timeoutMs: 5000, settleMs: 2500 } });
  });

  it('rejects negative or non-integer --timeout and --settle values', () => {
    expect(parseArgs(['doctor', 'https://x.example/', '--timeout', '-1'])).toMatchObject({ command: 'error' });
    expect(parseArgs(['doctor', 'https://x.example/', '--settle', 'nope'])).toMatchObject({ command: 'error' });
  });
});

describe('main', () => {
  it('prints usage and returns 2 on a parse error', async () => {
    const err: string[] = [];
    const code = await main(['doctor'], { out: () => undefined, err: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/usage/i);
  });

  it('returns the report exit code and prints json when asked', async () => {
    const out: string[] = [];
    const code = await main(['doctor', 'http://127.0.0.1:1/', '--json'], { out: (s) => out.push(s), err: () => undefined });
    expect(code).toBe(2);
    expect(JSON.parse(out.join(''))).toMatchObject({ url: 'http://127.0.0.1:1/' });
  });
});

describe('the built CLI', () => {
  // npm installs the bin as a symlink in node_modules/.bin. A packed install once
  // exited 0 with no output because the entry check compared the link path.
  it.skipIf(!existsSync('dist/node/cli/doctor.js'))('runs when started through a symlink, as npm installs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chw-bin-'));
    try {
      const link = join(dir, 'cardano-headless-wallet');
      symlinkSync(resolve('dist/node/cli/doctor.js'), link);
      const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
      expect(out).toContain('usage: cardano-headless-wallet doctor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
