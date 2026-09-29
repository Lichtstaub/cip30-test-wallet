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

/** native_script = [0, hash28] / [1, [* native_script]] / [2, [* native_script]] / [3, int, [* native_script]] / [4, uint] / [5, uint] */
export function isNativeScript(value: CborValue, depth = 0): boolean {
  if (depth > 256 || !Array.isArray(value) || typeof value[0] !== 'bigint') return false;
  const list = (items: CborValue) => Array.isArray(items) && items.every((item) => isNativeScript(item, depth + 1));
  switch (value[0]) {
    case 0n:
      return value.length === 2 && value[1] instanceof Uint8Array && value[1].length === 28;
    case 1n:
    case 2n:
      return value.length === 2 && list(value[1]);
    case 3n:
      return value.length === 3 && typeof value[1] === 'bigint' && list(value[2]);
    case 4n:
    case 5n:
      return value.length === 2 && typeof value[1] === 'bigint' && value[1] >= 0n;
    default:
      return false;
  }
}

/** script = [0, native_script] / [1, plutus_v1_script] / [2, plutus_v2_script] / [3, plutus_v3_script] */
export function isScript(value: CborValue): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  if (value[0] === 0n) return isNativeScript(value[1]);
  return (value[0] === 1n || value[0] === 2n || value[0] === 3n) && value[1] instanceof Uint8Array && value[1].length > 0;
}
