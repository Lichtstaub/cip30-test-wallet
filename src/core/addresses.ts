import { bech32 } from '@scure/base';
import { concat } from './bytes.js';
import { keyHash } from './hash.js';

// Shelley address header byte: high nibble is the type, low nibble the
// network tag (0 testnets, 1 mainnet). Type 0 is key payment + key stake,
// type 14 (0xe) is a reward address with a key credential. Odd types have a
// script payment credential. CIP-19 has the full table.

const HASH_LENGTH = 28;

function assertHash(h: Uint8Array, what: string): void {
  if (h.length !== HASH_LENGTH) throw new Error(`${what} hash must be ${HASH_LENGTH} bytes`);
}

export function baseAddressBytes(networkId: 0 | 1, paymentHash: Uint8Array, stakeHash: Uint8Array): Uint8Array {
  assertHash(paymentHash, 'payment');
  assertHash(stakeHash, 'stake');
  return concat(Uint8Array.of(0x00 | networkId), paymentHash, stakeHash);
}

export function rewardAddressBytes(networkId: 0 | 1, stakeHash: Uint8Array): Uint8Array {
  assertHash(stakeHash, 'stake');
  return concat(Uint8Array.of(0xe0 | networkId), stakeHash);
}

/** The base and reward addresses for a payment and stake public key, the pair every caller needs together. */
export function walletAddresses(networkId: 0 | 1, paymentPub: Uint8Array, stakePub: Uint8Array): { base: Uint8Array; reward: Uint8Array } {
  const stakeHash = keyHash(stakePub);
  return {
    base: baseAddressBytes(networkId, keyHash(paymentPub), stakeHash),
    reward: rewardAddressBytes(networkId, stakeHash),
  };
}

/** CIP-19 type 6, a key payment credential without delegation part. dApps build one from the DRep key hash for CIP-95 signData. */
export function enterpriseAddressBytes(networkId: 0 | 1, keyHash: Uint8Array): Uint8Array {
  assertHash(keyHash, 'payment');
  return concat(Uint8Array.of(0x60 | networkId), keyHash);
}

/** CIP-129 DRep id: header 0x22 (DRep, key hash) plus the hash, bech32 with prefix drep. */
export function cip129DRepId(keyHash: Uint8Array): string {
  assertHash(keyHash, 'DRep key');
  return bech32.encode('drep', bech32.toWords(concat(Uint8Array.of(0x22), keyHash)), false);
}

function header(address: Uint8Array): number {
  const h = address[0];
  if (h === undefined) throw new Error('empty address');
  return h;
}

export function networkTag(address: Uint8Array): number {
  return header(address) & 0x0f;
}

export function isRewardAddress(address: Uint8Array): boolean {
  return (header(address) >> 4) === 0x0e || (header(address) >> 4) === 0x0f;
}

export function isScriptPayment(address: Uint8Array): boolean {
  if (isRewardAddress(address)) return (header(address) >> 4) === 0x0f;
  return ((header(address) >> 4) & 0x01) === 1;
}

/** Byron addresses (type 8) predate the Shelley header layout. Not evaluated in the spike. */
export function isByronAddress(address: Uint8Array): boolean {
  return (header(address) >> 4) === 0x08;
}

/** The 28-byte credential hash that follows the header, payment or stake for reward addresses. */
export function paymentHash(address: Uint8Array): Uint8Array {
  if (address.length < 1 + HASH_LENGTH) throw new Error('address too short for a credential');
  return address.slice(1, 1 + HASH_LENGTH);
}

export function toBech32(address: Uint8Array): string {
  const mainnet = networkTag(address) === 1;
  const prefix = isRewardAddress(address) ? (mainnet ? 'stake' : 'stake_test') : mainnet ? 'addr' : 'addr_test';
  return bech32.encode(prefix, bech32.toWords(address), false);
}

export function assertNetwork(address: Uint8Array, networkId: number): void {
  if (networkTag(address) !== networkId) {
    throw new Error(`address network tag ${networkTag(address)} does not match wallet network ${networkId}`);
  }
}
