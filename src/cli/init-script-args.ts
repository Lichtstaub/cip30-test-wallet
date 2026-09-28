// Argument parsing for the init-script command. Kept free of wallet imports so the
// CLI entry can parse every command without loading key derivation.
import { takeValue } from './args.js';

export interface InitScriptArgs {
  /** Path of a JSON file holding WalletOptions. */
  optionsFile?: string;
  networkId?: 0 | 1;
  name?: string;
  /** Name of the environment variable holding the mnemonic, so it never appears in argv. */
  mnemonicEnv?: string;
  /** Output path, stdout when absent. */
  out?: string;
}

const STRING_FLAGS = {
  '--options': 'optionsFile',
  '--name': 'name',
  '--mnemonic-env': 'mnemonicEnv',
  '--out': 'out',
} as const satisfies Record<string, keyof InitScriptArgs>;

export function parseInitScriptArgs(rest: string[]): { command: 'init-script'; args: InitScriptArgs } | { command: 'error'; message: string } {
  const args: InitScriptArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag !== '--network' && !(flag in STRING_FLAGS)) return { command: 'error', message: `unknown flag ${flag}` };
    const v = takeValue(rest, i);
    if (!v) return { command: 'error', message: `${flag} needs a value` };
    i = v.next;
    if (flag === '--network') {
      if (v.value !== '0' && v.value !== '1') return { command: 'error', message: '--network needs 0 (testnet) or 1 (mainnet)' };
      args.networkId = Number(v.value) as 0 | 1;
    } else args[STRING_FLAGS[flag as keyof typeof STRING_FLAGS]] = v.value;
  }
  return { command: 'init-script', args };
}
