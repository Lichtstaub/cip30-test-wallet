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
