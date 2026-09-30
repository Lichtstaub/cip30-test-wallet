import { Tagged, type CborValue } from '../core/cbor/decode.js';

// Shape checks for configuration input, following the Conway CDDL. They reject
// CBOR that parses but that no ledger or CSL would accept as that type.

/**
 * plutus_data = constr / {* plutus_data => plutus_data} / [* plutus_data] / big_int / bounded_bytes
 * Byte strings of any length pass: the decoder joins chunked strings, so the
 * 64 byte chunk limit of bounded_bytes cannot be seen here.
 */
export function isPlutusData(value: CborValue, depth = 0): boolean {
  if (depth > 256) return false;
  const all = (items: CborValue[]) => items.every((item) => isPlutusData(item, depth + 1));
  if (typeof value === 'bigint' || value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return all(value);
  if (value instanceof Map) return all([...value.keys()]) && all([...value.values()]);
  if (value instanceof Tagged) {
    const { tag, value: inner } = value;
    if (tag === 2n || tag === 3n) return inner instanceof Uint8Array; // big_uint, big_nint
    if ((tag >= 121n && tag <= 127n) || (tag >= 1280n && tag <= 1400n)) return Array.isArray(inner) && all(inner);
    // constr with an explicit alternative: #6.102([uint, [* plutus_data]])
    if (tag === 102n) return Array.isArray(inner) && inner.length === 2 && typeof inner[0] === 'bigint' && inner[0] >= 0n && Array.isArray(inner[1]) && all(inner[1]);
  }
  return false;
}
