import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { addAssets, assetQuantity, hasAssets, parseAssetUnits, valueCbor, type MultiAsset } from '../src/core/value.js';

const P1 = '01'.repeat(28);
const P9 = '09'.repeat(28);

describe('value', () => {
  it('parses units into policy and name, lower case, empty name allowed', () => {
    const assets = parseAssetUnits({ [P9 + '7A7A']: '3', [P9]: '1', [P1 + '41']: '2' });
    expect(assetQuantity(assets, P9, '7a7a')).toBe(3n);
    expect(assetQuantity(assets, P9, '')).toBe(1n);
    expect(assetQuantity(assets, P1, '41')).toBe(2n);
    expect(assetQuantity(assets, P1, '42')).toBe(0n);
  });

  it('merges quantities of the same unit written in different case', () => {
    const assets = parseAssetUnits({ [P1 + 'aa']: '1', [P1 + 'AA']: '2' });
    expect(assetQuantity(assets, P1, 'aa')).toBe(3n);
  });

  it('adds assets across outputs', () => {
    const total: MultiAsset = new Map();
    addAssets(total, parseAssetUnits({ [P1 + '41']: '2' }));
    addAssets(total, parseAssetUnits({ [P1 + '41']: '5', [P9]: '1' }));
    addAssets(total, undefined);
    expect(assetQuantity(total, P1, '41')).toBe(7n);
    expect(hasAssets(total)).toBe(true);
    expect(hasAssets(new Map())).toBe(false);
    expect(hasAssets(undefined)).toBe(false);
  });

  it('encodes a coin-only value as a plain uint', () => {
    expect(bytesToHex(encode(valueCbor(5n, undefined)))).toBe('05');
    expect(bytesToHex(encode(valueCbor(5n, new Map())))).toBe('05');
  });

  it('encodes a multi-asset value byte for byte like CSL, in canonical order', () => {
    const names = ['7a7a', '61', '626262', '4141', '62', ''];
    const assets = parseAssetUnits(Object.fromEntries([...names.map((n, i) => [P9 + n, String(i + 1)]), [P1 + '61', '9']]));
    const ma = CSL.MultiAsset.new();
    for (const [policy, list] of [[P9, names.map((n, i) => [n, i + 1] as const)], [P1, [['61', 9] as const]]] as const) {
      const a = CSL.Assets.new();
      for (const [n, q] of list) a.insert(CSL.AssetName.new(Buffer.from(n, 'hex')), CSL.BigNum.from_str(String(q)));
      ma.insert(CSL.ScriptHash.from_hex(policy), a);
    }
    const csl = CSL.Value.new_with_assets(CSL.BigNum.from_str('2000000'), ma).to_hex();
    expect(bytesToHex(encode(valueCbor(2_000_000n, assets)))).toBe(csl);
  });

  it('accepts 2^64 - 1 and refuses 2^64, and the encoder never truncates an integer', () => {
    expect(assetQuantity(parseAssetUnits({ [P1]: '18446744073709551615' }), P1, '')).toBe(18446744073709551615n);
    expect(() => parseAssetUnits({ [P1]: '18446744073709551616' })).toThrow(/2\^64/);
    expect(() => parseAssetUnits({ [P1 + 'aa']: '18446744073709551615', [P1 + 'AA']: '1' })).toThrow(/2\^64/);
    expect(bytesToHex(encode(18446744073709551615n))).toBe('1bffffffffffffffff');
    expect(() => encode(18446744073709551616n)).toThrow(/out of range/);
    expect(bytesToHex(encode(-18446744073709551616n))).toBe('3bffffffffffffffff');
    expect(() => encode(-18446744073709551617n)).toThrow(/out of range/);
  });

  it('rejects malformed units and quantities', () => {
    expect(() => parseAssetUnits({ ['01'.repeat(27)]: '1' })).toThrow(/policy/);
    expect(() => parseAssetUnits({ [P1 + '0'.repeat(66)]: '1' })).toThrow(/asset name/);
    expect(() => parseAssetUnits({ [P1 + 'zz']: '1' })).toThrow(/hex/);
    expect(() => parseAssetUnits({ [P1]: '0' })).toThrow(/positive/);
    expect(() => parseAssetUnits({ [P1]: '-1' })).toThrow(/positive/);
    expect(() => parseAssetUnits({ [P1]: '0x10' })).toThrow(/positive integer/);
  });
});
