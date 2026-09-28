// The init-script command: writes the page bundle plus an installed wallet
// config as one JavaScript file, for browser drivers that take an init script
// by path instead of through the Playwright fixture (Playwright MCP, for one).
import { readFileSync, writeFileSync } from 'node:fs';
import { initScript } from '../host/bundle.js';
import { prepareWallet, type WalletOptions } from '../host/config.js';
import type { InitScriptArgs } from './init-script-args.js';

/** WalletOptions from the options file, with the flags applied on top. */
export function resolveWalletOptions(args: InitScriptArgs, env: NodeJS.ProcessEnv = process.env): WalletOptions {
  const options: WalletOptions = {};
  if (args.optionsFile !== undefined) {
    const parsed: unknown = JSON.parse(readFileSync(args.optionsFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${args.optionsFile} must hold a JSON object of wallet options`);
    }
    Object.assign(options, parsed);
  }
  if (args.networkId !== undefined) options.networkId = args.networkId;
  if (args.name !== undefined) options.name = args.name;
  if (args.mnemonicEnv !== undefined) {
    const mnemonic = env[args.mnemonicEnv];
    if (!mnemonic) throw new Error(`environment variable ${args.mnemonicEnv} is empty or not set`);
    options.mnemonic = mnemonic;
  }
  return options;
}

/** Writes the script to args.out, or returns it for stdout when no path is given. */
export function runInitScript(args: InitScriptArgs, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const options = resolveWalletOptions(args, env);
  // The script exists to install the wallet, a file that does not would be a silent no-op.
  if (options.install === false) throw new Error('install: false has no effect in an init script, leave it out');
  const script = initScript(prepareWallet(options).config);
  if (args.out === undefined) return script;
  writeFileSync(args.out, script);
  return undefined;
}
