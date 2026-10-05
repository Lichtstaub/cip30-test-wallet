import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Data, InlineDatum, PlutusV3, ScriptHash, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import type { Utxo } from '../src/core/ledger.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { expectedScriptDataHash, languageViews } from '../src/host/checks/script-integrity.js';
import { DEFAULT_COST_MODELS, type CostModels } from '../src/host/cost-models.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { buildTx, spliceWitnessSet, TEST_ADDRESS } from './helpers/build-tx.js';
import { checkContext } from './helpers/check-context.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { scriptAddress, syntheticInput } from './helpers/synthetic.js';

const ALWAYS = plutusScript('v3_always_succeeds');

const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const own: Utxo = { input: syntheticInput('integrity-own', 0n), address: TEST_ADDRESS, lovelace: 50_000_000n };
const paramsWith = (costModels: Partial<CostModels>) => ({ ...DEFAULT_PROTOCOL_PARAMS[0], costModels: { ...DEFAULT_COST_MODELS, ...costModels } });
const expectedOf = (ctx: ReturnType<typeof checkContext>) => expectedScriptDataHash(ctx, plutusNeeds(ctx));

/** A CSL cost model with exactly these parameters. */
function cslCostModel(params: bigint[]): CSL.CostModel {
  const model = CSL.CostModel.new();
  params.forEach((p, i) => model.set(i, CSL.Int.from_str(p.toString())));
  return model;
}

describe('languageViews', () => {
  const v1 = DEFAULT_COST_MODELS.PlutusV1;
  const v3 = DEFAULT_COST_MODELS.PlutusV3;

  it('writes PlutusV1 under the key 41 00 as a byte string around an indefinite list', () => {
    const list = concat(Uint8Array.of(0x9f), ...v1.map((n) => encode(n)), Uint8Array.of(0xff));
    expect(bytesToHex(languageViews(new Set([1]), DEFAULT_COST_MODELS))).toBe('a1' + '4100' + bytesToHex(encode(list)));
  });

  it('writes PlutusV2 and V3 under 01 and 02 as definite lists, a negative parameter included', () => {
    expect(v3.some((n) => n < 0n)).toBe(true);
    expect(bytesToHex(languageViews(new Set([3]), DEFAULT_COST_MODELS))).toBe('a1' + '02' + bytesToHex(encode(v3)));
    expect(bytesToHex(languageViews(new Set([2]), DEFAULT_COST_MODELS))).toBe('a1' + '01' + bytesToHex(encode(DEFAULT_COST_MODELS.PlutusV2)));
  });

  it('orders the keys shortest first, then by bytes: V2, V3, V1', () => {
    const views = languageViews(new Set([1, 3, 2]), DEFAULT_COST_MODELS);
    const one = (language: 1 | 2 | 3) => languageViews(new Set([language]), DEFAULT_COST_MODELS).slice(1);
    expect(views).toEqual(concat(Uint8Array.of(0xa3), one(2), one(3), one(1)));
  });

  it('writes an absent cost model as null, inside the byte string for PlutusV1', () => {
    expect(bytesToHex(languageViews(new Set([3]), { ...DEFAULT_COST_MODELS, PlutusV3: [] }))).toBe('a102f6');
    expect(bytesToHex(languageViews(new Set([1]), { ...DEFAULT_COST_MODELS, PlutusV1: [] }))).toBe('a1410041f6');
  });

  it('is an empty map without languages', () => {
    expect(bytesToHex(languageViews(new Set(), DEFAULT_COST_MODELS))).toBe('a0');
  });

  it('hashes like CSL.hash_script_data with all three languages behind a redeemer', () => {
    const costModels = CSL.Costmdls.new();
    costModels.insert(CSL.Language.new_plutus_v1(), cslCostModel(v1));
    costModels.insert(CSL.Language.new_plutus_v2(), cslCostModel(DEFAULT_COST_MODELS.PlutusV2));
    costModels.insert(CSL.Language.new_plutus_v3(), cslCostModel(v3));
    const redeemers = CSL.Redeemers.new();
    redeemers.add(CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(0), CSL.PlutusData.new_integer(CSL.BigInt.from_str('1')), CSL.ExUnits.new(big(1), big(1))));
    const ours = blake2b(concat(redeemers.to_bytes(), languageViews(new Set([1, 2, 3]), DEFAULT_COST_MODELS)), { dkLen: 32 });
    expect(ours).toEqual(CSL.hash_script_data(redeemers, costModels).to_bytes());
  });
});

describe('expectedScriptDataHash', () => {
  it('equals body key 11 of a Plutus V3 spend Evolution built with the preprod cost models', async () => {
    const plutus = new PlutusV3.PlutusV3({ bytes: ALWAYS.bytes });
    const hash = ScriptHash.fromScript(plutus);
    const lockedInput = syntheticInput('integrity-locked', 0n);
    const locked: Utxo = { input: lockedInput, address: scriptAddress(ALWAYS.hash), lovelace: 5_000_000n, datum: { kind: 'inline', cbor: hexToBytes('01') } };
    const lockedEvo = new UTxO.UTxO({
      transactionId: TransactionHash.fromBytes(lockedInput.txId),
      index: 0n,
      address: new Address.Address({ networkId: 0, paymentCredential: hash }),
      assets: Assets.fromLovelace(5_000_000n),
      datumOption: new InlineDatum.InlineDatum({ data: Data.int(1n) }),
    });
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [lockedEvo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      TEST_ADDRESS,
      [evolutionUtxo(own, TEST_ADDRESS)],
      { evaluator: fixedBudgetEvaluator },
    );
    const ctx = checkContext(tx, [own, locked]);
    expect(ctx.facts.scriptDataHash).toBeDefined();
    expect(expectedOf(ctx)).toEqual(ctx.facts.scriptDataHash);
  });

  it.each([
    ['V1', plutusScript('v1_always_succeeds'), () => CSL.Language.new_plutus_v1(), 'PlutusV1'],
    ['V2', plutusScript('v2_always_succeeds'), () => CSL.Language.new_plutus_v2(), 'PlutusV2'],
  ] as const)('equals CSL.hash_script_data for a Plutus %s spend with a datum hash and its witness datum', (_name, fixture, language, key) => {
    const script = CSL.PlutusScript.from_bytes_with_version(CSL.PlutusData.new_bytes(fixture.bytes).to_bytes(), language());
    const datum = CSL.PlutusData.new_integer(CSL.BigInt.from_str('42'));
    const locked: Utxo = { input: syntheticInput(`integrity-${key}`, 0n), address: scriptAddress(fixture.hash), lovelace: 5_000_000n, datum: { kind: 'hash', hash: CSL.hash_plutus_data(datum).to_bytes() } };
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(locked.input.txId), 0));
    const outputs = CSL.TransactionOutputs.new();
    outputs.add(CSL.TransactionOutput.new(CSL.Address.from_bytes(TEST_ADDRESS), CSL.Value.new(big(4_600_000))));
    const body = CSL.TransactionBody.new_tx_body(inputs, outputs, big(400_000));
    const witnesses = CSL.TransactionWitnessSet.new();
    const scripts = CSL.PlutusScripts.new();
    scripts.add(script);
    witnesses.set_plutus_scripts(scripts);
    const datums = CSL.PlutusList.new();
    datums.add(datum);
    witnesses.set_plutus_data(datums);
    const redeemers = CSL.Redeemers.new();
    redeemers.add(CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(0), CSL.PlutusData.new_empty_constr_plutus_data(big(0)), CSL.ExUnits.new(big(100_000), big(10_000_000))));
    witnesses.set_redeemers(redeemers);
    // Only the language the transaction uses, as a node builds the views.
    const costModels = CSL.Costmdls.new();
    costModels.insert(language(), cslCostModel(DEFAULT_COST_MODELS[key]));
    body.set_script_data_hash(CSL.hash_script_data(redeemers, costModels, datums));
    const ctx = checkContext(CSL.Transaction.new(body, witnesses).to_hex(), [locked]);
    expect(expectedOf(ctx)).toEqual(ctx.facts.scriptDataHash);
  });

  it('is undefined without redeemers, datums and Plutus scripts', () => {
    expect(expectedOf(checkContext(buildTx({ inputs: [own.input], outputs: [], fee: 200_000n }), [own]))).toBeUndefined();
  });

  it('covers datums alone: empty redeemers, the datums in their original bytes, no language views', () => {
    // A datum in the witness set for an output's datum hash, no script anywhere.
    const tx = spliceWitnessSet(buildTx({ inputs: [own.input], outputs: [], fee: 200_000n }), 'a104d9010281182a');
    expect(bytesToHex(expectedOf(checkContext(tx, [own]))!)).toBe(bytesToHex(blake2b(hexToBytes('a0' + 'd9010281182a' + 'a0'), { dkLen: 32 })));
  });

  it('covers redeemers alone in their original bytes, without datums and without a needed script', () => {
    // A redeemer nothing needs still enters the hash, an ExtraRedeemers transaction has one too.
    const redeemers = 'a182000082d87980820101';
    const tx = spliceWitnessSet(buildTx({ inputs: [own.input], outputs: [], fee: 200_000n }), 'a105' + redeemers);
    expect(bytesToHex(expectedOf(checkContext(tx, [own]))!)).toBe(bytesToHex(blake2b(hexToBytes(redeemers + 'a0'), { dkLen: 32 })));
  });

  it('takes the languages from needed and provided scripts, with the cost models of the parameters', async () => {
    const locked: Utxo = { input: syntheticInput('integrity-views', 0n), address: scriptAddress(ALWAYS.hash), lovelace: 5_000_000n, datum: { kind: 'inline', cbor: hexToBytes('01') } };
    const witnessSet = new Map<bigint, unknown>([[7n, [ALWAYS.bytes]], [5n, new Map([[[0n, 0n], [0n, [1n, 1n]]]])]]);
    const tx = buildTx({ inputs: [locked.input], outputs: [], fee: 200_000n, witnessSet });
    const redeemers = bytesToHex(encode(new Map([[[0n, 0n], [0n, [1n, 1n]]]]) as never));
    const views = (models: CostModels) => bytesToHex(languageViews(new Set([3]), models));
    expect(bytesToHex(expectedOf(checkContext(tx, [locked]))!)).toBe(bytesToHex(blake2b(hexToBytes(redeemers + views(DEFAULT_COST_MODELS)), { dkLen: 32 })));
    const other = paramsWith({ PlutusV3: [1n, 2n, 3n] });
    expect(bytesToHex(expectedOf(checkContext(tx, [locked], { params: other }))!)).toBe(bytesToHex(blake2b(hexToBytes(redeemers + views(other.costModels)), { dkLen: 32 })));
  });
});
