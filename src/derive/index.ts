// Node only. CIP-1852 derivation on top of bip32.ts.
// The page never sees this file, it receives finished extended keys.
import { mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { SigningKey } from '../core/keys.js';
import { type Bip32Key, HARDENED, derivePath, rootKey } from './bip32.js';

export interface DerivedAccount {
  payment: SigningKey;
  stake: SigningKey;
  drep: SigningKey;
}

// CIP-1852 roles: 0 external payment, 2 stake, 3 DRep (CIP-105).
function extended(account: Bip32Key, role: number): SigningKey {
  return { kind: 'extended', bytes: derivePath(account, [role, 0]).slice(0, 64) };
}

export function deriveAccount(mnemonic: string, accountIndex = 0): DerivedAccount {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= HARDENED) {
    throw new Error(`accountIndex must be an integer from 0 to 2^31 - 1, got ${accountIndex}`);
  }
  const root = rootKey(mnemonicToEntropy(mnemonic, wordlist));
  const account = derivePath(root, [HARDENED + 1852, HARDENED + 1815, HARDENED + accountIndex]);
  return {
    payment: extended(account, 0),
    stake: extended(account, 2),
    drep: extended(account, 3),
  };
}
