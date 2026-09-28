#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitCode, formatHuman, formatJson } from '../checks/report.js';
import { runDoctor, type DoctorOptions } from '../host/doctor.js';
import { takeValue } from './args.js';
import { parseInitScriptArgs, type InitScriptArgs } from './init-script-args.js';

export const USAGE = `usage: cip30-test-wallet doctor <url> [--deep] [--browser chromium|firefox|webkit] [--click <selector>] [--expect <selector>] [--inject-after <ms>] [--timeout <ms>] [--settle <ms>] [--json]

Checks a deployed dApp for the traps that keep Cardano wallets from injecting:
secure context, content security policy versus eval, and with --deep, when the
page touches window.cardano and whether an injected wallet is detected.
--timeout bounds the static fetch (default 15000 ms), --settle bounds how long
the deep run waits after load and click before reading the probes.
Exit codes: 0 clean, 1 findings, 2 the run itself failed.

usage: cip30-test-wallet init-script [--options <file.json>] [--network 0|1] [--name <name>] [--mnemonic-env <VAR>] [--out <file.js>]

Prints the test wallet as one init script, for browser drivers that load a
script file before the page's own scripts, such as Playwright MCP with
--init-script. --options reads wallet options as JSON, the same shape as the
fixture's walletOptions. --mnemonic-env names the environment variable that
holds the mnemonic, so it stays out of the command line. The script contains
the wallet's private keys, use test mnemonics only.`;

type Parsed =
  | { command: 'doctor'; url: string; json: boolean; options: DoctorOptions }
  | { command: 'init-script'; args: InitScriptArgs }
  | { command: 'help' }
  | { command: 'error'; message: string };

const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

export function parseArgs(argv: string[]): Parsed {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { command: 'help' };
  if (argv[0] === 'init-script') return parseInitScriptArgs(argv.slice(1));
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
  if (parsed.command === 'init-script') {
    // Loaded on demand, so a doctor run never pays for the key derivation stack.
    const { runInitScript } = await import('./init-script.js');
    const script = runInitScript(parsed.args);
    if (script !== undefined) io.out(script);
    return 0;
  }
  const report = await runDoctor(parsed.url, parsed.options);
  io.out(parsed.json ? formatJson(report) : formatHuman(report));
  return exitCode(report);
}

// npm starts the CLI through a symlink in node_modules/.bin, so argv[1] is the link
// while import.meta.url is the resolved file. Only resolved paths compare equal.
function isEntryModule(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/** Exits once stdout and stderr are flushed. A bare process.exit cuts piped output off at the pipe buffer, 64 KB on most systems. */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

if (isEntryModule()) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }).then(
    (code) => exitAfterFlush(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      exitAfterFlush(2);
    },
  );
}
