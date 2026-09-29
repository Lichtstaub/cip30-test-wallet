import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../src/core/bytes.js';
import type { Utxo } from '../src/core/ledger.js';
import { selectCollateral, selectForAmount } from '../src/core/select.js';
import { parseAssetUnits } from '../src/core/value.js';
import { syntheticInput } from './helpers/synthetic.js';

const P = 'ab'.repeat(28);
const address = hexToBytes('00' + '11'.repeat(56));
const u = (i: number, lovelace: bigint, units?: Record<string, string>, extra: Partial<Utxo> = {}): Utxo => ({
  input: syntheticInput('s', BigInt(i)),
  address,
  lovelace,
  ...(units ? { assets: parseAssetUnits(units) } : {}),
  ...extra,
});
const ids = (list: Utxo[] | null) => list?.map((x) => x.input.index);
const none = new Map() as ReturnType<typeof parseAssetUnits>;

describe('selectForAmount', () => {
  it('takes pure ADA first for coin, in config order', () => {
    const utxos = [u(0, 10_000_000n, { [P + '41']: '1' }), u(1, 3_000_000n), u(2, 4_000_000n)];
    expect(ids(selectForAmount(utxos, 5_000_000n, none))).toEqual([1n, 2n]);
  });

  it('falls back to a token-holding UTxO for coin when pure ADA is not enough', () => {
    expect(ids(selectForAmount([u(0, 10_000_000n, { [P + '41']: '1' })], 5_000_000n, none))).toEqual([0n]);
  });

  it('covers an asset across several UTxOs, then the rest of the coin', () => {
    const utxos = [u(0, 2_000_000n, { [P + '41']: '2' }), u(1, 1_000_000n), u(2, 2_000_000n, { [P + '41']: '3' }), u(3, 9_000_000n)];
    const want = parseAssetUnits({ [P + '41']: '4' });
    expect(ids(selectForAmount(utxos, 8_000_000n, want))).toEqual([0n, 1n, 2n, 3n]);
    expect(ids(selectForAmount(utxos, 1_000_000n, want))).toEqual([0n, 2n]);
  });

  it('covers the coin rest of an asset demand with token-holding UTxOs only', () => {
    const utxos = [u(0, 2_000_000n, { [P + '41']: '1' }), u(1, 5_000_000n, { [P]: '1' })];
    expect(ids(selectForAmount(utxos, 6_000_000n, parseAssetUnits({ [P + '41']: '1' })))).toEqual([0n, 1n]);
  });

  it('selects an asset with an empty name', () => {
    expect(ids(selectForAmount([u(0, 1n), u(1, 1n, { [P]: '5' })], 0n, parseAssetUnits({ [P]: '5' })))).toEqual([1n]);
  });

  it('returns null when an asset or the coin cannot be reached', () => {
    const utxos = [u(0, 2_000_000n, { [P + '41']: '1' })];
    expect(selectForAmount(utxos, 0n, parseAssetUnits({ [P + '41']: '2' }))).toBeNull();
    expect(selectForAmount(utxos, 3_000_000n, none)).toBeNull();
  });
});

describe('selectCollateral', () => {
  it('takes pure ADA UTxOs without datum and script, at most three, in config order', () => {
    const utxos = [
      u(0, 9_000_000n, { [P]: '1' }),
      u(1, 1_000_000n, undefined, { datum: { kind: 'hash', hash: new Uint8Array(32) } }),
      u(2, 1_000_000n),
      u(3, 1_000_000n),
      u(4, 1_000_000n),
      u(5, 9_000_000n),
    ];
    expect(ids(selectCollateral(utxos, 2_000_000n))).toEqual([2n, 3n]);
    expect(ids(selectCollateral([u(0, 9_000_000n)], 5_000_000n))).toEqual([0n]);
  });

  it('takes the largest pure UTxOs when the first three in config order are not enough', () => {
    const utxos = [u(0, 1_000_000n), u(1, 1_000_000n), u(2, 1_000_000n), u(3, 9_000_000n)];
    expect(ids(selectCollateral(utxos, 4_000_000n))).toEqual([3n]);
    // First pass: 1 + 2 + 1 = 4 ADA. Second pass, largest first: 2 + 1.5 + 1 = 4.5 ADA, returned in config order.
    const small = [u(0, 1_000_000n), u(1, 2_000_000n), u(2, 1_000_000n), u(3, 1_500_000n)];
    expect(ids(selectCollateral(small, 4_500_000n))).toEqual([0n, 1n, 3n]);
    expect(selectCollateral(small, 5_000_000n)).toBeNull(); // the three largest bring 4.5 ADA
  });

  it('returns null when only token-holding UTxOs exist', () => {
    expect(selectCollateral([u(0, 50_000_000n, { [P]: '1' })], 5_000_000n)).toBeNull();
  });
});
