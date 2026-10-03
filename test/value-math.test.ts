import { describe, expect, it } from 'vitest';
import { addValues, formatValue, valuesEqual, type Value } from '../src/host/checks/value-math.js';
import type { MultiAsset } from '../src/core/value.js';

const A = 'aa'.repeat(28);
const B = 'bb'.repeat(28);
const assets = (entries: Array<[string, string, bigint]>): MultiAsset => {
  const out: MultiAsset = new Map();
  for (const [policy, name, quantity] of entries) {
    const names = out.get(policy) ?? new Map<string, bigint>();
    names.set(name, quantity);
    out.set(policy, names);
  }
  return out;
};
const coin = (c: bigint): Value => ({ coin: c, assets: new Map() });

describe('addValues', () => {
  it('adds coin and assets and drops what sums to zero', () => {
    const sum = addValues({ coin: 5n, assets: assets([[A, '41', 3n], [B, '', 1n]]) }, { coin: 7n, assets: assets([[A, '41', -3n], [A, '42', 2n]]) }, coin(1n));
    expect(sum).toEqual({ coin: 13n, assets: assets([[B, '', 1n], [A, '42', 2n]]) });
    expect(sum.assets.get(A)?.has('41')).toBe(false);
  });

  it('is zero for no values and leaves its inputs unchanged', () => {
    expect(addValues()).toEqual(coin(0n));
    const a = { coin: 1n, assets: assets([[A, '41', 1n]]) };
    addValues(a, a);
    expect(a).toEqual({ coin: 1n, assets: assets([[A, '41', 1n]]) });
  });
});

describe('valuesEqual', () => {
  it.each<[string, Value, Value, boolean]>([
    ['equal coin', coin(5n), coin(5n), true],
    ['different coin', coin(5n), coin(6n), false],
    ['a zero quantity against no asset', { coin: 5n, assets: assets([[A, '41', 0n]]) }, coin(5n), true],
    ['an empty policy map against no asset', { coin: 5n, assets: new Map([[A, new Map()]]) }, coin(5n), true],
    ['same assets in another order', { coin: 1n, assets: assets([[A, '41', 1n], [B, '42', 2n]]) }, { coin: 1n, assets: assets([[B, '42', 2n], [A, '41', 1n]]) }, true],
    ['another quantity', { coin: 1n, assets: assets([[A, '41', 1n]]) }, { coin: 1n, assets: assets([[A, '41', 2n]]) }, false],
    ['another asset name', { coin: 1n, assets: assets([[A, '41', 1n]]) }, { coin: 1n, assets: assets([[A, '42', 1n]]) }, false],
    ['an extra asset on one side', { coin: 1n, assets: assets([[A, '41', 1n], [A, '42', 1n]]) }, { coin: 1n, assets: assets([[A, '41', 1n]]) }, false],
    ['negative quantities', { coin: 0n, assets: assets([[A, '41', -2n]]) }, { coin: 0n, assets: assets([[A, '41', -2n]]) }, true],
  ])('%s', (_name, a, b, equal) => {
    expect(valuesEqual(a, b)).toBe(equal);
    expect(valuesEqual(b, a)).toBe(equal);
  });
});

describe('formatValue', () => {
  it('shows a coin-only value as Coin', () => {
    expect(formatValue(coin(5n))).toBe('Coin 5');
    expect(formatValue({ coin: 5n, assets: assets([[A, '41', 0n]]) })).toBe('Coin 5');
  });

  it('shows assets as a MaryValue with policies and names in ledger order', () => {
    const v = { coin: 2_000_000n, assets: assets([[B, '41', 3n], [A, '42', 1n], [A, '', 7n], [A, '41', -4n]]) };
    expect(formatValue(v)).toBe(
      `MaryValue (Coin 2000000) (MultiAsset (fromList [(PolicyID {policyID = ScriptHash "${A}"},fromList [("",7),("41",-4),("42",1)]),(PolicyID {policyID = ScriptHash "${B}"},fromList [("41",3)])]))`,
    );
  });
});
