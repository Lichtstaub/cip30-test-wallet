// Node side. Turns the friendly WalletOptions into the JSON PageConfig,
// deriving keys through Evolution here so the page never needs bip39 or
// BIP32 code.
import { baseAddressBytes, rewardAddressBytes, toBech32 } from '../core/addresses.js';
import { bytesToHex } from '../core/bytes.js';
import { keyHash, publicKey } from '../core/keys.js';
import { deriveAccount } from '../derive/index.js';
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

const lovelaceString = (v: number | bigint | string): string => BigInt(v).toString();

export function prepareWallet(options: WalletOptions = {}): PreparedWallet {
  const networkId = options.networkId ?? 0;
  const account = deriveAccount(options.mnemonic ?? DEFAULT_MNEMONIC, options.accountIndex ?? 0);
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
