import { hexToBytes } from './bytes.js';
import type { CborValue } from './cbor/decode.js';

// Native assets as the wallet holds them. Keys are lower case hex so two
// spellings of the same unit are the same Map entry.

/** policy id hex -> asset name hex -> quantity, all hex lower case. */
export type MultiAsset = Map<string, Map<string, bigint>>;

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

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
    if (!HEX_RE.test(unit)) throw new Error(`asset unit ${rawUnit} must be hex`);
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
    const names = out.get(policy) ?? new Map<string, bigint>();
    const total = (names.get(name) ?? 0n) + quantity;
    if (total > MAX_UINT64) throw new Error(`asset quantity for ${rawUnit} is above 2^64 - 1`);
    names.set(name, total);
    out.set(policy, names);
  }
  return out;
}

export function assetQuantity(assets: MultiAsset | undefined, policy: string, name: string): bigint {
  return assets?.get(policy)?.get(name) ?? 0n;
}

export function hasAssets(assets: MultiAsset | undefined): boolean {
  if (!assets) return false;
  for (const names of assets.values()) for (const quantity of names.values()) if (quantity > 0n) return true;
  return false;
}

export function addAssets(into: MultiAsset, add: MultiAsset | undefined): void {
  if (!add) return;
  for (const [policy, names] of add) {
    const target = into.get(policy) ?? new Map<string, bigint>();
    for (const [name, quantity] of names) target.set(name, (target.get(name) ?? 0n) + quantity);
    into.set(policy, target);
  }
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
    for (const name of [...names.keys()].sort(canonical)) {
      const quantity = names.get(name)!;
      if (quantity > 0n) inner.set(hexToBytes(name), quantity);
    }
    if (inner.size > 0) multiasset.set(hexToBytes(policy), inner);
  }
  return [coin, multiasset];
}
