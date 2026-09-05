// Node only. CIP-1852 derivation through Evolution, which is pure TypeScript.
// The page never sees this file, it receives finished extended keys.
import { Bip32PrivateKey, PrivateKey } from '@evolution-sdk/evolution';
import { mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { SigningKey } from '../core/keys.js';

export interface DerivedAccount {
  payment: SigningKey;
  stake: SigningKey;
}

function extended(root: Bip32PrivateKey.Bip32PrivateKey, path: string): SigningKey {
  const key = Bip32PrivateKey.toPrivateKey(Bip32PrivateKey.derivePath(root, path));
  const bytes = PrivateKey.toBytes(key);
  if (bytes.length !== 64) throw new Error('expected a 64 byte extended key from derivation');
  return { kind: 'extended', bytes };
}

export function deriveAccount(mnemonic: string, accountIndex = 0): DerivedAccount {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  const root = Bip32PrivateKey.fromBip39Entropy(mnemonicToEntropy(mnemonic, wordlist));
  return {
    payment: extended(root, `m/1852'/1815'/${accountIndex}'/0/0`),
    stake: extended(root, `m/1852'/1815'/${accountIndex}'/2/0`),
  };
}
