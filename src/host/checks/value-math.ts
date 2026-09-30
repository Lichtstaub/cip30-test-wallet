import { addAsset, type MultiAsset } from '../../core/value.js';

// Values as the value balance of the UTXO rule adds and compares them. Quantities
// may be negative here (a burn in the mint field), the MultiAsset invariant of
// the wallet's own holdings does not apply.

export interface Value {
  coin: bigint;
  assets: MultiAsset;
}

/** A copy without zero quantities and without empty policies, the form Mary MultiAsset normalises to. */
function withoutZeros(assets: MultiAsset): MultiAsset {
  const out: MultiAsset = new Map();
  for (const [policy, names] of assets) {
    for (const [name, quantity] of names) if (quantity !== 0n) addAsset(out, policy, name, quantity);
  }
  return out;
}

export function addValues(...values: Value[]): Value {
  const assets: MultiAsset = new Map();
  let coin = 0n;
  for (const v of values) {
    coin += v.coin;
    for (const [policy, names] of v.assets) for (const [name, quantity] of names) addAsset(assets, policy, name, quantity);
  }
  return { coin, assets: withoutZeros(assets) };
}

/** Equal after dropping zero quantities. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a.coin !== b.coin) return false;
  const x = withoutZeros(a.assets);
  const y = withoutZeros(b.assets);
  if (x.size !== y.size) return false;
  for (const [policy, names] of x) {
    const other = y.get(policy);
    if (!other || other.size !== names.size) return false;
    for (const [name, quantity] of names) if (other.get(name) !== quantity) return false;
  }
  return true;
}

// Mary Value.hs orders policies by script hash and asset names by their bytes.
// On lower case hex both are plain string order.
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 'Coin 5' or 'MaryValue (Coin 5) (MultiAsset (fromList [(<policy>,fromList [(<name>,3)])]))'. */
export function formatValue(v: Value): string {
  const assets = withoutZeros(v.assets);
  if (assets.size === 0) return `Coin ${v.coin}`;
  const policies = [...assets.keys()].sort(byString).map((policy) => {
    const names = assets.get(policy)!;
    const inner = [...names.keys()].sort(byString).map((name) => `("${name}",${names.get(name)!})`);
    return `(PolicyID {policyID = ScriptHash "${policy}"},fromList [${inner.join(',')}])`;
  });
  return `MaryValue (Coin ${v.coin}) (MultiAsset (fromList [${policies.join(',')}]))`;
}
