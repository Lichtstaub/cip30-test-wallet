import { readFileSync } from 'node:fs';
import { Address, Transaction, UTxO } from '@evolution-sdk/evolution';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { preprod } from '@evolution-sdk/evolution/sdk/client/Chain';
import type { ProtocolParameters } from '@evolution-sdk/evolution/sdk/provider/Provider';

// Recorded once from Koios preprod (see docs/recipes.md, "Protocol parameters offline"), so the builder runs without a network.
interface KoiosEpochParams {
  min_fee_a: number; min_fee_b: number; max_tx_size: number; max_val_size: number;
  key_deposit: string; pool_deposit: string; drep_deposit: string; gov_action_deposit: string;
  price_mem: number; price_step: number; max_tx_ex_mem: number; max_tx_ex_steps: number;
  coins_per_utxo_size: string; collateral_percent: number; max_collateral_inputs: number;
  min_fee_ref_script_cost_per_byte: number; cost_models: Record<'PlutusV1' | 'PlutusV2' | 'PlutusV3', number[]>;
}

/** Koios epoch_params field names to Evolution's Provider.ProtocolParameters. */
export function toEvolutionParams(k: KoiosEpochParams): ProtocolParameters {
  const model = (costs: number[]) => Object.fromEntries(costs.map((c, i) => [String(i), c]));
  return {
    minFeeA: k.min_fee_a, minFeeB: k.min_fee_b, maxTxSize: k.max_tx_size, maxValSize: k.max_val_size,
    keyDeposit: BigInt(k.key_deposit), poolDeposit: BigInt(k.pool_deposit), drepDeposit: BigInt(k.drep_deposit), govActionDeposit: BigInt(k.gov_action_deposit),
    priceMem: k.price_mem, priceStep: k.price_step, maxTxExMem: BigInt(k.max_tx_ex_mem), maxTxExSteps: BigInt(k.max_tx_ex_steps),
    coinsPerUtxoByte: BigInt(k.coins_per_utxo_size), collateralPercentage: k.collateral_percent, maxCollateralInputs: k.max_collateral_inputs,
    minFeeRefScriptCostPerByte: k.min_fee_ref_script_cost_per_byte,
    costModels: { PlutusV1: model(k.cost_models.PlutusV1), PlutusV2: model(k.cost_models.PlutusV2), PlutusV3: model(k.cost_models.PlutusV3) },
  };
}

const koios = (JSON.parse(readFileSync(new URL('../fixtures/koios-epoch-params-preprod.json', import.meta.url), 'utf8')) as KoiosEpochParams[])[0]!;

export async function evolutionBuild(configure: (b: ReturnType<typeof makeTxBuilder>) => void, changeAddress: Uint8Array, availableUtxos: UTxO.UTxO[]): Promise<string> {
  const builder = makeTxBuilder({ chain: preprod });
  configure(builder);
  const built = await builder.build({
    changeAddress: Address.fromBytes(changeAddress),
    availableUtxos,
    fullProtocolParameters: toEvolutionParams(koios),
  });
  return Transaction.toCBORHex(await built.toTransaction());
}
