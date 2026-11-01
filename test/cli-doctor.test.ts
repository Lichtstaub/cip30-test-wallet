import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCTOR_USAGE, INIT_SCRIPT_USAGE, main, parseArgs, USAGE } from '../src/cli/doctor.js';

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
    expect(parseArgs(['-h'])).toEqual({ command: 'help' });
  });

  it('takes --help or -h anywhere after a command as help for that command', () => {
    expect(parseArgs(['doctor', '--help'])).toEqual({ command: 'help', topic: 'doctor' });
    expect(parseArgs(['doctor', 'https://x.example/', '-h'])).toEqual({ command: 'help', topic: 'doctor' });
    expect(parseArgs(['doctor', 'https://x.example/', '--bogus', '--help'])).toEqual({ command: 'help', topic: 'doctor' });
    expect(parseArgs(['init-script', '--help'])).toEqual({ command: 'help', topic: 'init-script' });
    expect(parseArgs(['init-script', '--network', '0', '-h'])).toEqual({ command: 'help', topic: 'init-script' });
  });

  it('rejects a url that is not http or https', () => {
    expect(parseArgs(['doctor', 'mailto:x'])).toMatchObject({ command: 'error', message: expect.stringMatching(/not a http or https url/) });
  });

  it('parses --click-timeout into the options', () => {
    const r = parseArgs(['doctor', 'https://x.example/', '--click-timeout', '250']);
    expect(r).toEqual({ command: 'doctor', url: 'https://x.example/', json: false, options: { clickTimeoutMs: 250 } });
  });

  it('rejects a --click-timeout that is not a positive integer', () => {
    for (const v of ['0', '-1', '1.5', 'x']) {
      expect(parseArgs(['doctor', 'https://x.example/', '--click-timeout', v])).toEqual({ command: 'error', message: '--click-timeout needs a positive integer', topic: 'doctor' });
    }
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

describe('usage', () => {
  it('combines both command usages into the top-level one', () => {
    expect(USAGE).toBe(`${DOCTOR_USAGE}\n\n${INIT_SCRIPT_USAGE}`);
  });
});

describe('main', () => {
  it('prints a one-line error with a pointer to the command help and returns 2', async () => {
    const err: string[] = [];
    const code = await main(['doctor', 'https://x.example/', '--bogus'], { out: () => undefined, err: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join('\n')).toBe('unknown flag --bogus\nrun cip30-test-wallet doctor --help for the usage');
  });

  it('points an unknown command to the top-level help', async () => {
    const err: string[] = [];
    const code = await main(['nope'], { out: () => undefined, err: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join('\n')).toBe('unknown command nope\nrun cip30-test-wallet --help for the usage');
  });

  it('prints only the doctor usage for doctor --help and returns 0', async () => {
    const out: string[] = [];
    const code = await main(['doctor', '--help'], { out: (s) => out.push(s), err: () => undefined });
    expect(code).toBe(0);
    expect(out.join('\n')).toBe(DOCTOR_USAGE);
    expect(out.join('\n')).not.toContain('init-script [--options');
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
      const link = join(dir, 'cip30-test-wallet');
      symlinkSync(resolve('dist/node/cli/doctor.js'), link);
      const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
      expect(out).toContain('usage: cip30-test-wallet doctor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
