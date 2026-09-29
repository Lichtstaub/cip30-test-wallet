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
  const picked = new Set<Utxo>();
  for (const [policy, names] of assets) {
    for (const [name, wanted] of names) {
      let have = 0n;
      for (const utxo of picked) have += assetQuantity(utxo.assets, policy, name);
      for (const utxo of utxos) {
        if (have >= wanted) break;
        if (picked.has(utxo)) continue;
        const quantity = assetQuantity(utxo.assets, policy, name);
        if (quantity > 0n) {
          picked.add(utxo);
          have += quantity;
        }
      }
      if (have < wanted) return null;
    }
  }
  let sum = 0n;
  for (const utxo of picked) sum += utxo.lovelace;
  const pureFirst = [...utxos.filter((u) => !hasAssets(u.assets)), ...utxos.filter((u) => hasAssets(u.assets))];
  for (const utxo of pureFirst) {
    if (sum >= coin) break;
    if (picked.has(utxo)) continue;
    picked.add(utxo);
    sum += utxo.lovelace;
  }
  if (sum < coin) return null;
  return utxos.filter((u) => picked.has(u));
}

/**
 * CIP-30 getCollateral: pure ADA UTxOs without datum or reference script, at
 * most MAX_COLLATERAL_INPUTS, until the sum reaches the amount. First in
 * configured order. If that falls short within the input limit, a second
 * pass takes the largest ones first (ties keep configured order). Returned
 * in configured order, null when even the largest ones are not enough.
 */
export function selectCollateral(utxos: readonly Utxo[], amount: bigint): Utxo[] | null {
  const candidates = utxos.filter((u) => !hasAssets(u.assets) && !u.datum && !u.scriptRef);
  // Array.prototype.sort is stable, so equal amounts keep their configured order.
  const largestFirst = [...candidates].sort((a, b) => (a.lovelace < b.lovelace ? 1 : a.lovelace > b.lovelace ? -1 : 0));
  for (const order of [candidates, largestFirst]) {
    const picked = new Set<Utxo>();
    let sum = 0n;
    for (const utxo of order) {
      if (sum >= amount || picked.size === MAX_COLLATERAL_INPUTS) break;
      picked.add(utxo);
      sum += utxo.lovelace;
    }
    if (sum >= amount) return utxos.filter((u) => picked.has(u));
  }
  return null;
}
