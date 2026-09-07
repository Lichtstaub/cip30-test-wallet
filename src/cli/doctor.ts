#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { exitCode, formatHuman, formatJson } from '../checks/report.js';
import { runDoctor, type DoctorOptions } from '../host/doctor.js';

export const USAGE = `usage: cardano-headless-wallet doctor <url> [--deep] [--browser chromium|firefox|webkit] [--click <selector>] [--expect <selector>] [--inject-after <ms>] [--timeout <ms>] [--settle <ms>] [--json]

Checks a deployed dApp for the traps that keep Cardano wallets from injecting:
secure context, content security policy versus eval, and with --deep, when the
page touches window.cardano and whether an injected wallet is detected.
--timeout bounds the static fetch (default 15000 ms), --settle bounds how long
the deep run waits after load and click before reading the probes.
Exit codes: 0 clean, 1 findings, 2 the run itself failed.`;

type Parsed =
  | { command: 'doctor'; url: string; json: boolean; options: DoctorOptions }
  | { command: 'help' }
  | { command: 'error'; message: string };

const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

/** The value following rest[i], or undefined when the flag is the last argument. next is the index that value was read from. */
function takeValue(rest: string[], i: number): { value: string; next: number } | undefined {
  const value = rest[i + 1];
  if (value === undefined) return undefined;
  return { value, next: i + 1 };
}

export function parseArgs(argv: string[]): Parsed {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { command: 'help' };
  if (argv[0] !== 'doctor') return { command: 'error', message: `unknown command ${argv[0]}` };
  const [, url, ...rest] = argv;
  if (!url) return { command: 'error', message: 'missing url' };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { command: 'error', message: `not a url: ${url}` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { command: 'error', message: `not a http or https url: ${url}` };
  }
  const options: DoctorOptions = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--deep') options.deep = true;
    else if (flag === '--json') json = true;
    else if (flag === '--browser') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      if (!BROWSERS.has(v.value)) return { command: 'error', message: `unknown browser ${v.value}` };
      options.browser = v.value as NonNullable<DoctorOptions['browser']>;
    } else if (flag === '--click') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      options.click = v.value;
    } else if (flag === '--expect') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      options.expect = v.value;
    } else if (flag === '--inject-after') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      const ms = Number(v.value);
      if (!Number.isInteger(ms) || ms < 0) return { command: 'error', message: '--inject-after needs a non-negative integer' };
      options.injectAfterMs = ms;
    } else if (flag === '--timeout') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      const ms = Number(v.value);
      if (!Number.isInteger(ms) || ms < 0) return { command: 'error', message: '--timeout needs a non-negative integer' };
      options.timeoutMs = ms;
    } else if (flag === '--settle') {
      const v = takeValue(rest, i);
      if (!v) return { command: 'error', message: `${flag} needs a value` };
      i = v.next;
      const ms = Number(v.value);
      if (!Number.isInteger(ms) || ms < 0) return { command: 'error', message: '--settle needs a non-negative integer' };
      options.settleMs = ms;
    } else return { command: 'error', message: `unknown flag ${flag}` };
  }
  return { command: 'doctor', url, json, options };
}

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (parsed.command === 'error') {
    io.err(`${parsed.message}\n${USAGE}`);
    return 2;
  }
  const report = await runDoctor(parsed.url, parsed.options);
  io.out(parsed.json ? formatJson(report) : formatHuman(report));
  return exitCode(report);
}

const isEntry = typeof process !== 'undefined' && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
