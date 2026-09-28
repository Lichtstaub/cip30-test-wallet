// Node side. Turns the friendly WalletOptions into the JSON PageConfig,
// deriving keys here so the page never needs bip39 or BIP32 code.
import { cip129DRepId, toBech32, walletAddresses } from '../core/addresses.js';
import { bytesToHex } from '../core/bytes.js';
import { keyHash } from '../core/hash.js';
import { publicKey } from '../core/keys.js';
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
  /** CIP-95: report the stake key as registered. Defaults to false, a fresh wallet. */
  stakeRegistered?: boolean;
}

export interface PreparedWallet {
  config: PageConfig;
  addresses: { payment: string; reward: string };
  paymentPublicKeyHex: string;
  stakePublicKeyHex: string;
  drepPublicKeyHex: string;
  drepKeyHashHex: string;
  drepId: string;
}

function lovelaceString(v: number | bigint | string): string {
  if (typeof v !== 'number' && typeof v !== 'bigint' && typeof v !== 'string') {
    throw new Error(`lovelace must be a non-negative integer, got ${String(v)}`);
  }
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  }
  if (n < 0n) throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  return n.toString();
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/** Checked here so a bad entry fails in Node with a clear message, not later inside the page. */
function foreignUtxo(f: { txId: string; index: number; addressHex: string; lovelace: number | bigint | string }, i: number) {
  const where = `foreignUtxos[${i}]`;
  if (typeof f.txId !== 'string' || f.txId.length !== 64 || !HEX_RE.test(f.txId)) throw new Error(`${where}.txId must be 64 hex characters`);
  if (!Number.isSafeInteger(f.index) || f.index < 0) throw new Error(`${where}.index must be a non-negative integer, got ${f.index}`);
  // 29 bytes is the shortest Shelley address (enterprise or reward).
  if (typeof f.addressHex !== 'string' || !HEX_RE.test(f.addressHex) || f.addressHex.length < 58) {
    throw new Error(`${where}.addressHex must be the hex bytes of an address`);
  }
  return { txId: f.txId.toLowerCase(), index: f.index, addressHex: f.addressHex.toLowerCase(), lovelace: lovelaceString(f.lovelace) };
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
  const account = cachedDeriveAccount(options.mnemonic ?? DEFAULT_MNEMONIC, accountIndex);
  const paymentPub = publicKey(account.payment);
  const stakePub = publicKey(account.stake);
  const drepPub = publicKey(account.drep);
  const drepHash = keyHash(drepPub);
  const { base, reward } = walletAddresses(networkId, paymentPub, stakePub);

  const config: PageConfig = {
    name: options.name ?? 'chw',
    displayName: options.displayName ?? 'Test Wallet',
    icon: options.icon ?? DEFAULT_ICON,
    networkId,
    keys: {
      payment: { kind: account.payment.kind, hex: bytesToHex(account.payment.bytes) },
      stake: { kind: account.stake.kind, hex: bytesToHex(account.stake.bytes) },
      drep: { kind: account.drep.kind, hex: bytesToHex(account.drep.bytes) },
    },
    utxos: (options.utxos ?? [{ lovelace: 10_000_000 }]).map((u) => ({ lovelace: lovelaceString(u.lovelace) })),
    foreignUtxos: (options.foreignUtxos ?? []).map(foreignUtxo),
    quirks: { ...(options.quirks ?? {}) },
    stakeRegistered: options.stakeRegistered ?? false,
  };

  return {
    config,
    addresses: { payment: toBech32(base), reward: toBech32(reward) },
    paymentPublicKeyHex: bytesToHex(paymentPub),
    stakePublicKeyHex: bytesToHex(stakePub),
    drepPublicKeyHex: bytesToHex(drepPub),
    drepKeyHashHex: bytesToHex(drepHash),
    drepId: cip129DRepId(drepHash),
  };
}
