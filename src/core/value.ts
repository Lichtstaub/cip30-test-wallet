import { hexToBytes, isHex } from './bytes.js';
import type { CborValue } from './cbor/decode.js';

// Native assets as the wallet holds them. Keys are lower case hex so two
// spellings of the same unit are the same Map entry.

/**
 * policy id hex -> asset name hex -> quantity, all hex lower case. Invariant:
 * every quantity is positive and no inner map is empty. parseAssetUnits,
 * addAsset with positive quantities and parseValue keep it.
 */
export type MultiAsset = Map<string, Map<string, bigint>>;

/** Conway positive_coin and coin top out at 2^64 - 1, the largest CBOR uint. */
export const MAX_UINT64 = 18446744073709551615n;

/**
 * Units as Blockfrost and Mesh write them: policy id hex (56 characters)
 * followed by the asset name hex (0 to 64 characters). Quantities are
 * decimal strings and must be positive. Throws a plain Error, callers in
 * Node turn it into a configuration message.
 */
export function parseAssetUnits(units: Record<string, string>): MultiAsset {
  const out: MultiAsset = new Map();
  for (const [rawUnit, rawQuantity] of Object.entries(units)) {
    const unit = rawUnit.toLowerCase();
    if (!isHex(unit)) throw new Error(`asset unit ${rawUnit} must be hex`);
    if (unit.length < 56) throw new Error(`asset unit ${rawUnit} needs a 28 byte policy id`);
    const policy = unit.slice(0, 56);
    const name = unit.slice(56);
    if (name.length > 64) throw new Error(`asset unit ${rawUnit} has an asset name longer than 32 bytes`);
    // Decimal digits only: BigInt would also take 0x10, 0b1 and surrounding whitespace.
    if (typeof rawQuantity !== 'string' || !/^\d+$/.test(rawQuantity)) {
      throw new Error(`asset quantity for ${rawUnit} must be a positive integer, got ${rawQuantity}`);
    }
    const quantity = BigInt(rawQuantity);
    if (quantity <= 0n) throw new Error(`asset quantity for ${rawUnit} must be a positive integer, got ${rawQuantity}`);
    if (assetQuantity(out, policy, name) + quantity > MAX_UINT64) throw new Error(`asset quantity for ${rawUnit} is above 2^64 - 1`);
    addAsset(out, policy, name, quantity);
  }
  return out;
}

export function assetQuantity(assets: MultiAsset | undefined, policy: string, name: string): bigint {
  return assets?.get(policy)?.get(name) ?? 0n;
}

export function hasAssets(assets: MultiAsset | undefined): boolean {
  return assets !== undefined && assets.size > 0;
}

/** Adds quantity to one unit, creating the policy map on first use. */
export function addAsset(into: MultiAsset, policy: string, name: string, quantity: bigint): void {
  const names = into.get(policy) ?? new Map<string, bigint>();
  names.set(name, (names.get(name) ?? 0n) + quantity);
  into.set(policy, names);
}

export function addAssets(into: MultiAsset, add: MultiAsset | undefined): void {
  if (!add) return;
  for (const [policy, names] of add) for (const [name, quantity] of names) addAsset(into, policy, name, quantity);
}

// Canonical CBOR map order, the order CSL emits: shorter key first, then
// bytewise. Policy ids all have 28 bytes. On lower case hex of equal length
// string order is byte order.
const canonical = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** value = coin / [coin, multiasset<positive_coin>], a plain uint when no asset is held. */
export function valueCbor(coin: bigint, assets: MultiAsset | undefined): CborValue {
  if (!hasAssets(assets)) return coin;
  const multiasset = new Map<CborValue, CborValue>();
  for (const policy of [...assets!.keys()].sort(canonical)) {
    const names = assets!.get(policy)!;
    const inner = new Map<CborValue, CborValue>();
    for (const name of [...names.keys()].sort(canonical)) inner.set(hexToBytes(name), names.get(name)!);
    multiasset.set(hexToBytes(policy), inner);
  }
  return [coin, multiasset];
}
