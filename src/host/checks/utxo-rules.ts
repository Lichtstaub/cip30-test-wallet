import { isByronAddress, isScriptPayment, toBech32 } from '../../core/addresses.js';
import { bytesToHex } from '../../core/bytes.js';
import { arrayItemRanges, decode } from '../../core/cbor/decode.js';
import { lookupInputs, type TxInput } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';
import { scriptFromRef } from '../../core/scripts.js';
import type { MultiAsset } from '../../core/value.js';
import type { ProtocolParams, Rational } from '../protocol-params.js';
import { depositsAndRefunds } from './cert-state.js';
import type { CheckContext } from './context.js';
import { mismatch, PATH, type Failure } from './failure.js';
import { headerNetwork, type SizedOutput } from './read-tx.js';
import { addValues, formatValue, valuesEqual, type Value } from './value-math.js';

// The UTXO rule of a Conway node: Babbage/Rules/Utxo.hs babbageUtxoValidation,
// with validators from the Shelley, Allegra and Alonzo UTXO rules. Every check
// runs and adds its failure, the node reports them all together.

// Conway/PParams.hs: ppRefScriptCostMultiplierG 1.2 and ppRefScriptCostStrideG 25600, fixed.
const REF_SCRIPT_STRIDE = 25_600n;
// Babbage/TxOut.hs babbageMinUTxOValue: overhead of the TxIn and the map entry.
const UTXO_ENTRY_OVERHEAD = 160n;

/** core/Plutus/ExUnits.hs txscriptfee: one ceiling over mem × priceMem + steps × priceSteps. */
export function scriptFee(params: ProtocolParams, mem: bigint, steps: bigint): bigint {
  const { priceMem: pm, priceSteps: ps } = params;
  const numerator = mem * pm.numerator * ps.denominator + steps * ps.numerator * pm.denominator;
  const denominator = pm.denominator * ps.denominator;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Conway/Tx.hs tierRefScriptFee with multiplier 6/5 and stride 25600: every
 * full stride costs the current price per byte, then the price grows by 6/5.
 * Exact rationals over one shared denominator, a single floor at the end.
 */
export function tierRefScriptFee(costPerByte: Rational, size: bigint): bigint {
  let denominator = costPerByte.denominator;
  let price = costPerByte.numerator;
  let acc = 0n;
  let rest = size;
  while (rest >= REF_SCRIPT_STRIDE) {
    acc += REF_SCRIPT_STRIDE * price;
    // price × 6/5, acc keeps its value over the grown denominator
    price *= 6n;
    acc *= 5n;
    denominator *= 5n;
    rest -= REF_SCRIPT_STRIDE;
  }
  return (acc + rest * price) / denominator;
}

const outpoint = (input: TxInput) => `${bytesToHex(input.txId)}#${input.index}`;
const list = (items: readonly string[]) => `[${items.join(', ')}]`;

/**
 * The bytes the script hash covers, what Conway counts as originalBytesSize:
 * the script CBOR of a native script, the content of the byte string of a
 * Plutus script, without the language tag.
 */
function refScriptBytes(ref: Uint8Array): bigint {
  const script = scriptFromRef(ref);
  const [, [start, end]] = arrayItemRanges(ref, 0, false).ranges as [[number, number], [number, number]];
  if (script.language === 0) return BigInt(end - start);
  return BigInt((decode(ref.slice(start, end)) as Uint8Array).length);
}

/** The resolved spend inputs and reference inputs, one entry per outpoint. Collateral inputs are no source of scripts. */
function scriptSourceUtxos(ctx: CheckContext): Utxo[] {
  const { body } = ctx.parsed;
  const seen = new Map<string, Utxo>();
  lookupInputs(body).forEach(({ input, label }, i) => {
    const utxo = ctx.resolved[i];
    if (label !== 'collateral input' && utxo) seen.set(outpoint(input), utxo);
  });
  return [...seen.values()];
}

/**
 * Conway/UTxO.hs txNonDistinctRefScriptsSize: the reference scripts of the
 * UTxOs of spend and reference inputs. A TxIn in both sets counts once, the
 * same script in two UTxOs twice.
 */
export function refScriptsSize(ctx: CheckContext): bigint {
  let size = 0n;
  for (const utxo of scriptSourceUtxos(ctx)) if (utxo.scriptRef) size += refScriptBytes(utxo.scriptRef);
  return size;
}

function totalExUnits(ctx: CheckContext): { mem: bigint; steps: bigint } {
  let mem = 0n;
  let steps = 0n;
  for (const r of ctx.facts.redeemers) {
    mem += r.mem;
    steps += r.steps;
  }
  return { mem, steps };
}

/** Conway/Tx.hs getConwayMinFeeTx: alonzoMinFeeTx (size fee plus script fee) plus the reference script fee. */
export function minFee(ctx: CheckContext): bigint {
  const { params, facts } = ctx;
  const { mem, steps } = totalExUnits(ctx);
  return params.minFeeA * facts.size + params.minFeeB + scriptFee(params, mem, steps) + tierRefScriptFee(params.minFeeRefScriptCostPerByte, refScriptsSize(ctx));
}

/** Babbage/TxOut.hs babbageMinUTxOValue: (160 + bytes of the output as it stands in the body) × coinsPerUTxOByte. */
export function minUtxo(output: SizedOutput, params: ProtocolParams): bigint {
  return (UTXO_ENTRY_OVERHEAD + BigInt(output.size)) * params.coinsPerUtxoByte;
}

const valueOf = (u: { lovelace: bigint; assets?: MultiAsset }): Value => ({ coin: u.lovelace, assets: u.assets ?? new Map() });

function mapAssets(assets: MultiAsset, f: (q: bigint) => bigint): MultiAsset {
  const out: MultiAsset = new Map();
  for (const [policy, names] of assets) {
    const inner = new Map<string, bigint>();
    for (const [name, quantity] of names) if (f(quantity) !== 0n) inner.set(name, f(quantity));
    if (inner.size > 0) out.set(policy, inner);
  }
  return out;
}

const negate = (v: Value): Value => ({ coin: -v.coin, assets: mapAssets(v.assets, (q) => -q) });
/** Val.isAdaOnly: no asset with a quantity other than zero, negative ones included. */
const isAdaOnly = (v: Value) => [...v.assets.values()].every((names) => [...names.values()].every((q) => q === 0n));
const network = (id: bigint | number) => (BigInt(id) === 1n ? 'Mainnet' : BigInt(id) === 0n ? 'Testnet' : `Network ${id}`);

/**
 * UTXO in the order of Babbage/Rules/Utxo.hs babbageUtxoValidation. Not
 * reported: InputSetEmptyUTxO (the mempool check catches every such
 * transaction first), OutsideForecast (no slot calendar), the Byron
 * attribute size (Byron outputs are an unsupported form).
 */
export function utxoFailures(ctx: CheckContext): Failure[] {
  const { parsed, facts, params, resolved } = ctx;
  const { body } = parsed;
  const failures: Failure[] = [];
  const fail = (rule: string, detail?: string) => failures.push(detail === undefined ? { path: PATH.UTXO, rule } : { path: PATH.UTXO, rule, detail });

  const lookup = lookupInputs(body);
  const inputCount = body.inputs.length;
  const collateralCount = body.collateralInputs.length;
  const unique = (from: number, to: number) => {
    const seen = new Map<string, Utxo>();
    for (let i = from; i < to; i++) {
      const utxo = resolved[i];
      if (utxo) seen.set(outpoint(lookup[i]!.input), utxo);
    }
    return seen;
  };
  const spent = unique(0, inputCount);
  // Babbage/Rules/Utxo.hs feesOK: Map.restrictKeys utxo collateral, only the collateral the UTxO set holds.
  const collateral = unique(inputCount, inputCount + collateralCount);

  // Allegra/Rules/Utxo.hs validateOutsideValidityIntervalUTxO, only with a current slot.
  const slot = ctx.currentSlot;
  if (slot !== undefined) {
    const { validityStart, ttl } = body;
    const inside = (validityStart === undefined || validityStart <= slot) && (ttl === undefined || slot < ttl);
    if (!inside) {
      const bound = (b: bigint | undefined) => (b === undefined ? 'SNothing' : `SJust (SlotNo ${b})`);
      fail('OutsideValidityIntervalUTxO', `{invalidBefore: ${bound(validityStart)}, invalidHereafter: ${bound(ttl)}, slot: SlotNo ${slot}}`);
    }
  }

  // Babbage/Rules/Utxo.hs feesOK, part 1: minfee pp tx ≤ txfee.
  const expectedFee = minFee(ctx);
  if (facts.fee < expectedFee) fail('FeeTooSmallUTxO', mismatch('RelGTEQ', `Coin ${facts.fee}`, `Coin ${expectedFee}`));

  // feesOK, part 2: the collateral checks run only when the transaction carries redeemers (validateTotalCollateral).
  if (facts.redeemers.length > 0) {
    // Alonzo/Rules/Utxo.hs validateScriptsNotPaidUTxO: collateral must be locked by a key.
    const scriptLocked = [...collateral].filter(([, u]) => isScriptPayment(u.address)).map(([key]) => key);
    if (scriptLocked.length > 0) fail('ScriptsNotPaidUTxO', list(scriptLocked));

    // Babbage/Rules/Utxo.hs validateCollateralContainsNonADA: tokens are fine when the return gives all of them back.
    const collateralValue = addValues(...[...collateral.values()].map(valueOf));
    const returned = facts.collateralReturn ? valueOf(facts.collateralReturn.output) : undefined;
    const collateralAdaOnly = isAdaOnly(collateralValue);
    const allAdaOnly = collateralAdaOnly && (returned === undefined || isAdaOnly(returned));
    if (!allAdaOnly && !isAdaOnly(returned ? addValues(collateralValue, negate(returned)) : collateralValue)) {
      fail('CollateralContainsNonADA', formatValue(returned && collateralAdaOnly ? returned : collateralValue));
    }

    // Babbage/Rules/Utxo.hs collAdaBalance: collateral lovelace minus returned lovelace, may be negative.
    const balance = collateralValue.coin - (returned?.coin ?? 0n);
    // Alonzo/Rules/Utxo.hs validateInsufficientCollateral: balance × 100 ≥ fee × collateralPercent.
    if (balance * 100n < facts.fee * params.collateralPercent) {
      const required = (facts.fee * params.collateralPercent + 99n) / 100n;
      fail('InsufficientCollateral', `{balance: DeltaCoin ${balance}, required: Coin ${required}}`);
    }
    // Babbage/Rules/Utxo.hs validateCollateralEqBalance.
    if (facts.totalCollateral !== undefined && balance !== facts.totalCollateral) {
      fail('IncorrectTotalCollateralField', `{balance: DeltaCoin ${balance}, totalCollateral: Coin ${facts.totalCollateral}}`);
    }
    if (collateral.size === 0) fail('NoCollateralInputs');
  }

  // Shelley/Rules/Utxo.hs validateBadInputsUTxO over allInputs: spend, collateral and reference inputs.
  const bad = new Set<string>();
  lookup.forEach(({ input }, i) => {
    if (!resolved[i]) bad.add(outpoint(input));
  });
  if (bad.size > 0) fail('BadInputsUTxO', list([...bad]));

  // Shelley/Rules/Utxo.hs validateValueNotConservedUTxO with Conway consumed and produced.
  // Only resolved spend inputs count, the collateral return and total_collateral never do.
  const { deposits, refunds } = depositsAndRefunds(facts, ctx.certState, params);
  const withdrawn = facts.withdrawals.reduce((sum, w) => sum + w.amount, 0n);
  const consumed = addValues(...[...spent.values()].map(valueOf), { coin: withdrawn + refunds, assets: mapAssets(facts.mint, (q) => (q > 0n ? q : 0n)) });
  const produced = addValues(
    ...facts.outputs.map((o) => valueOf(o.output)),
    { coin: facts.fee + deposits + facts.treasuryDonation, assets: mapAssets(facts.mint, (q) => (q < 0n ? -q : 0n)) },
  );
  if (!valuesEqual(consumed, produced)) fail('ValueNotConservedUTxO', mismatch('RelEQ', formatValue(consumed), formatValue(produced)));

  // Babbage/TxBody.hs allSizedOutputsBabbageTxBodyF: the collateral return goes through the output checks too.
  const allOutputs: Array<[string, SizedOutput]> = facts.outputs.map((o, i) => [`output ${i}`, o]);
  if (facts.collateralReturn) allOutputs.push(['collateral return', facts.collateralReturn]);

  // Babbage/Rules/Utxo.hs validateOutputTooSmallUTxO, one failure listing every output below its minimum.
  const tooSmall = allOutputs.filter(([, o]) => o.output.lovelace < minUtxo(o, params)).map(([name, o]) => `(${name}, Coin ${minUtxo(o, params)})`);
  if (tooSmall.length > 0) fail('BabbageOutputTooSmallUTxO', list(tooSmall));

  // Alonzo/Rules/Utxo.hs validateOutputTooBigUTxO: serialized value ≤ maxValSize.
  const tooBig = allOutputs.filter(([, o]) => BigInt(o.valueSize) > params.maxValSize).map(([name, o]) => `(${name}, size ${o.valueSize}, max ${params.maxValSize})`);
  if (tooBig.length > 0) fail('OutputTooBigUTxO', list(tooBig));

  // Shelley/Rules/Utxo.hs validateWrongNetwork. Byron addresses never get here, they are an unsupported form.
  const wrongAddresses = new Set<string>();
  for (const [, o] of allOutputs) {
    const { address } = o.output;
    if (!isByronAddress(address) && headerNetwork(address) !== ctx.networkId) wrongAddresses.add(toBech32(address));
  }
  if (wrongAddresses.size > 0) fail('WrongNetwork', `{expected: ${network(ctx.networkId)}, addresses: ${list([...wrongAddresses])}}`);

  // Shelley/Rules/Utxo.hs validateWrongNetworkWithdrawal.
  const wrongAccounts = new Set(facts.withdrawals.filter((w) => headerNetwork(w.rewardAddress) !== ctx.networkId).map((w) => toBech32(w.rewardAddress)));
  if (wrongAccounts.size > 0) fail('WrongNetworkWithdrawal', `{expected: ${network(ctx.networkId)}, accounts: ${list([...wrongAccounts])}}`);

  // Alonzo/Rules/Utxo.hs validateWrongNetworkInTxBody, only when the body names a network.
  if (facts.networkId !== undefined && facts.networkId !== BigInt(ctx.networkId)) {
    fail('WrongNetworkInTxBody', mismatch('RelEQ', network(facts.networkId), network(ctx.networkId)));
  }

  // Shelley/Rules/Utxo.hs validateMaxTxSizeUTxO over sizeTxF.
  if (facts.size > params.maxTxSize) fail('MaxTxSizeUTxO', mismatch('RelLTEQ', `${facts.size}`, `${params.maxTxSize}`));

  // Alonzo/Rules/Utxo.hs validateExUnitsTooBigUTxO, pointwise over the summed ExUnits.
  const { mem, steps } = totalExUnits(ctx);
  if (mem > params.maxTxExMem || steps > params.maxTxExSteps) {
    fail('ExUnitsTooBigUTxO', mismatch('RelLTEQ', `ExUnits {mem: ${mem}, steps: ${steps}}`, `ExUnits {mem: ${params.maxTxExMem}, steps: ${params.maxTxExSteps}}`));
  }

  // Alonzo/Rules/Utxo.hs validateTooManyCollateralInputs, with or without redeemers, over the set of collateral inputs.
  const collateralInputs = new Set(body.collateralInputs.map(outpoint)).size;
  if (BigInt(collateralInputs) > params.maxCollateralInputs) {
    fail('TooManyCollateralInputs', mismatch('RelLTEQ', `${collateralInputs}`, `${params.maxCollateralInputs}`));
  }

  return failures;
}
