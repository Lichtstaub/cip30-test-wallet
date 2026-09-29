import type { Utxo } from './ledger.js';
import { assetQuantity, hasAssets, type MultiAsset } from './value.js';

// Deterministic selection in configured order, so a test reads the same
// UTxOs every run.

/**
 * maxCollateralInputs. A Conway protocol parameter, 3 on preprod and mainnet
 * (test/fixtures/koios-epoch-params-preprod.json). A fixed offline default
 * until the ledger reads protocol parameters.
 */
export const MAX_COLLATERAL_INPUTS = 3;

/**
 * CIP-30 getUtxos(amount): UTxOs that together hold at least the coin and
 * every asset asked for, or null. First, for each asset, the UTxOs carrying
 * it until its quantity is reached. Then, for the rest of the coin, the
 * unpicked UTxOs, pure ADA ones before token-holding ones. Returned in
 * configured order.
 */
export function selectForAmount(utxos: readonly Utxo[], coin: bigint, assets: MultiAsset): Utxo[] | null {
  const picked = new Set<number>();
  for (const [policy, names] of assets) {
    for (const [name, wanted] of names) {
      let have = 0n;
      for (const i of picked) have += assetQuantity(utxos[i]!.assets, policy, name);
      for (const [i, utxo] of utxos.entries()) {
        if (have >= wanted) break;
        if (picked.has(i)) continue;
        const quantity = assetQuantity(utxo.assets, policy, name);
        if (quantity > 0n) {
          picked.add(i);
          have += quantity;
        }
      }
      if (have < wanted) return null;
    }
  }
  let sum = 0n;
  for (const i of picked) sum += utxos[i]!.lovelace;
  const pureFirst = [...utxos.keys()].sort((a, b) => Number(hasAssets(utxos[a]!.assets)) - Number(hasAssets(utxos[b]!.assets)) || a - b);
  for (const i of pureFirst) {
    if (sum >= coin) break;
    if (picked.has(i)) continue;
    picked.add(i);
    sum += utxos[i]!.lovelace;
  }
  if (sum < coin) return null;
  return utxos.filter((_, i) => picked.has(i));
}

/**
 * CIP-30 getCollateral: pure ADA UTxOs without datum or reference script, at
 * most MAX_COLLATERAL_INPUTS, until the sum reaches the amount. First in
 * configured order. If that falls short within the input limit, a second
 * pass takes the largest ones first (ties keep configured order). Returned
 * in configured order, null when even the largest ones are not enough.
 */
export function selectCollateral(utxos: readonly Utxo[], amount: bigint): Utxo[] | null {
  const candidates = [...utxos.keys()].filter((i) => {
    const utxo = utxos[i]!;
    return !hasAssets(utxo.assets) && !utxo.datum && !utxo.scriptRef;
  });
  const largestFirst = [...candidates].sort((a, b) => {
    const diff = utxos[b]!.lovelace - utxos[a]!.lovelace;
    return diff > 0n ? 1 : diff < 0n ? -1 : a - b;
  });
  for (const order of [candidates, largestFirst]) {
    const picked = new Set<number>();
    let sum = 0n;
    for (const i of order) {
      if (sum >= amount || picked.size === MAX_COLLATERAL_INPUTS) break;
      picked.add(i);
      sum += utxos[i]!.lovelace;
    }
    if (sum >= amount) return utxos.filter((_, i) => picked.has(i));
  }
  return null;
}
