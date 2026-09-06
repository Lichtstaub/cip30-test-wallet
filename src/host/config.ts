// Node side. Turns the friendly WalletOptions into the JSON PageConfig,
// deriving keys through Evolution here so the page never needs bip39 or
// BIP32 code.
import { baseAddressBytes, rewardAddressBytes, toBech32 } from '../core/addresses.js';
import { bytesToHex } from '../core/bytes.js';
import { keyHash, publicKey } from '../core/keys.js';
import { deriveAccount, type DerivedAccount } from '../derive/index.js';
import type { PageConfig, QuirkConfig } from '../page/config.js';

/** Public test vector from the CSL documentation. Holds no funds, safe to ship. */
export const DEFAULT_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice';

/** A tiny inline SVG, so a dApp rendering <img src> does not re-request the document. */
export const DEFAULT_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%230033ad"/></svg>';

export interface WalletOptions {
  name?: string;
  displayName?: string;
  icon?: string;
  networkId?: 0 | 1;
  mnemonic?: string;
  accountIndex?: number;
  /** Whether the fixture installs the provider into the page at all. Defaults to true. */
  install?: boolean;
  utxos?: { lovelace: number | bigint | string }[];
  foreignUtxos?: { txId: string; index: number; addressHex: string; lovelace: number | bigint | string }[];
  quirks?: QuirkConfig;
}

export interface PreparedWallet {
  config: PageConfig;
  addresses: { payment: string; reward: string };
  paymentPublicKeyHex: string;
  stakePublicKeyHex: string;
}

function lovelaceString(v: number | bigint | string): string {
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  }
  if (n < 0n) throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  return n.toString();
}

function validateAccountIndex(v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`accountIndex must be a non-negative integer, got ${v}`);
}

function validateNetworkId(v: number): void {
  if (v !== 0 && v !== 1) throw new Error(`networkId must be 0 or 1, got ${v}`);
}

/** Repeated prepareWallet calls with the same mnemonic and accountIndex do not re-derive. */
const accountCache = new Map<string, DerivedAccount>();

function cachedDeriveAccount(mnemonic: string, accountIndex: number): DerivedAccount {
  const key = `${accountIndex}:${mnemonic}`;
  const cached = accountCache.get(key);
  if (cached) return cached;
  const account = deriveAccount(mnemonic, accountIndex);
  accountCache.set(key, account);
  return account;
}

export function prepareWallet(options: WalletOptions = {}): PreparedWallet {
  const networkId = options.networkId ?? 0;
  validateNetworkId(networkId);
  const accountIndex = options.accountIndex ?? 0;
  validateAccountIndex(accountIndex);
  const account = cachedDeriveAccount(options.mnemonic ?? DEFAULT_MNEMONIC, accountIndex);
  const paymentPub = publicKey(account.payment);
  const stakePub = publicKey(account.stake);
  const base = baseAddressBytes(networkId, keyHash(paymentPub), keyHash(stakePub));
  const reward = rewardAddressBytes(networkId, keyHash(stakePub));

  const config: PageConfig = {
    name: options.name ?? 'chw',
    displayName: options.displayName ?? 'Headless Wallet',
    icon: options.icon ?? DEFAULT_ICON,
    networkId,
    keys: {
      payment: { kind: account.payment.kind, hex: bytesToHex(account.payment.bytes) },
      stake: { kind: account.stake.kind, hex: bytesToHex(account.stake.bytes) },
    },
    utxos: (options.utxos ?? [{ lovelace: 10_000_000 }]).map((u) => ({ lovelace: lovelaceString(u.lovelace) })),
    foreignUtxos: (options.foreignUtxos ?? []).map((f) => ({ txId: f.txId, index: f.index, addressHex: f.addressHex, lovelace: lovelaceString(f.lovelace) })),
    quirks: { ...(options.quirks ?? {}) },
  };

  return {
    config,
    addresses: { payment: toBech32(base), reward: toBech32(reward) },
    paymentPublicKeyHex: bytesToHex(paymentPub),
    stakePublicKeyHex: bytesToHex(stakePub),
  };
}
