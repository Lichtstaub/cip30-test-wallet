import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Data, PlutusV3, ScriptHash, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { baseAddressBytes, rewardAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import type { Utxo } from '../src/core/ledger.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { deriveAccount } from '../src/derive/index.js';
import { prepareWallet } from '../src/host/config.js';
import { DEFAULT_PROTOCOL_PARAMS, type ProtocolParams } from '../src/host/protocol-params.js';
import type { CheckContext } from '../src/host/checks/context.js';
import { credentialKey } from '../src/host/checks/read-tx.js';
import { minFee, minUtxo, refScriptsSize, scriptFee, tierRefScriptFee, utxoFailures } from '../src/host/checks/utxo-rules.js';
import { syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx, outpoints } from './helpers/build-tx.js';
import { checkContext, emptyCertState } from './helpers/check-context.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { PLUTUS_V3, POLICY, hash28 as h, scriptAddress, syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const myAddress = baseAddressBytes(0, myPay, myStake);
const PREPROD = DEFAULT_PROTOCOL_PARAMS[0];
const PLUTUS = hexToBytes(PLUTUS_V3);
/** Testnet enterprise address with a script payment credential (header type 7). */
const bn = (n: bigint | number) => CSL.BigNum.from_str(n.toString());

const utxo = (seed: string, lovelace: bigint, extra: Partial<Utxo> = {}): Utxo => ({ input: syntheticInput(seed, 0n), address: myAddress, lovelace, ...extra });
/** One redeemer in the legacy array form, [tag, index, data, [mem, steps]]. */
const redeemers = (mem = 100_000n, steps = 10_000_000n) => new Map<bigint, unknown>([[5n, [[0n, 0n, new Tagged(121n, []), [mem, steps]]]]]);

const rules = (ctx: CheckContext) => utxoFailures(ctx).map((f) => f.rule);

const A = utxo('utxo-a', 10_000_000n);
const C = utxo('utxo-collateral', 5_000_000n);

interface Simple {
  inputs?: Utxo[];
  outputs?: Array<{ address: Uint8Array; lovelace: bigint }>;
  fee?: bigint;
  body?: Array<[bigint, unknown]>;
  witnessSet?: Map<bigint, unknown>;
}
/** A 10 ADA input paying 9.8 ADA back with a 0.2 ADA fee, balanced and above every minimum. */
function simple(opts: Simple = {}): string {
  return buildTx({
    inputs: (opts.inputs ?? [A]).map((u) => u.input),
    outputs: opts.outputs ?? [{ address: myAddress, lovelace: 9_800_000n }],
    fee: opts.fee ?? 200_000n,
    extraBodyEntries: new Map(opts.body ?? []),
    ...(opts.witnessSet ? { witnessSet: opts.witnessSet } : {}),
  });
}
/** The same shape with collateral C and one redeemer, so the collateral checks run. */
const withScript = (opts: Simple = {}) => simple({ ...opts, body: [[13n, outpoints(C)], ...(opts.body ?? [])], witnessSet: opts.witnessSet ?? redeemers() });

describe('fee arithmetic', () => {
  it('tierRefScriptFee agrees with CSL at the tier boundaries', () => {
    const perByte = CSL.UnitInterval.new(bn(15), bn(1));
    for (const size of [0, 1, 25_600, 25_601, 51_200, 204_800]) {
      expect(tierRefScriptFee({ numerator: 15n, denominator: 1n }, BigInt(size))).toBe(BigInt(CSL.min_ref_script_fee(size, perByte).to_str()));
    }
  });

  it('tierRefScriptFee floors once at the end, over a fractional price', () => {
    // 25601 bytes at 1/3: 25600/3 + 1 × (6/5 × 1/3) = 8533.73..., floor 8533
    expect(tierRefScriptFee({ numerator: 1n, denominator: 3n }, 25_601n)).toBe(8533n);
    const perByte = CSL.UnitInterval.new(bn(1), bn(3));
    expect(tierRefScriptFee({ numerator: 1n, denominator: 3n }, 25_601n)).toBe(BigInt(CSL.min_ref_script_fee(25_601, perByte).to_str()));
  });

  it('scriptFee rounds up once over the sum of both prices', () => {
    expect(scriptFee(PREPROD, 0n, 0n)).toBe(0n);
    // 0.0577 + 0.0000721, one ceiling
    expect(scriptFee(PREPROD, 1n, 1n)).toBe(1n);
    // Two redeemers of (1, 1) summed first: ceil(0.1154 + 0.0001442) = 1, two separate ceilings would give 2.
    expect(scriptFee(PREPROD, 2n, 2n)).toBe(1n);
    expect(scriptFee(PREPROD, 100_000n, 10_000_000n)).toBe(6491n);
  });

  it('minUtxo is (160 + output bytes) × coinsPerUtxoByte', () => {
    expect(minUtxo({ output: { address: myAddress, lovelace: 1n }, size: 65, valueSize: 1 }, PREPROD)).toBe(969_750n);
  });
});

describe('minimum fee against CSL', () => {
  const w = prepareWallet({ utxos: [{ lovelace: 50_000_000 }, { lovelace: 10_000_000 }] });
  const address = parseAddressArg(w.addresses.payment);
  const own = [50_000_000n, 10_000_000n].map((l, i) => syntheticOwnedUtxo(w.config.name, i, address, l));
  const ownEvo = own.map((u) => evolutionUtxo(u, address));
  const plutus = new PlutusV3.PlutusV3({ bytes: PLUTUS });

  /** A UTxO at the script address of plutus, optionally holding a reference script, for the context and for Evolution. */
  function lockedBy(seed: string, scriptRef?: PlutusV3.PlutusV3) {
    const input = syntheticInput(seed, 0n);
    const scriptAddr = new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(plutus) });
    const evo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address: scriptAddr, assets: Assets.fromLovelace(5_000_000n), ...(scriptRef ? { scriptRef } : {}) });
    const ours: Utxo = { input, address: Address.toBytes(scriptAddr), lovelace: 5_000_000n, ...(scriptRef ? { scriptRef: encode([3n, scriptRef.bytes]) } : {}) };
    return { evo, ours };
  }

  /** CSL counts the full wire size, the ledger (sizeTxF) one byte less, the is_valid byte. */
  function expectCslFee(tx: string, ctx: CheckContext): void {
    const csl = CSL.Transaction.from_hex(tx);
    // CSL measures its own serialization, which must have the length of the original bytes.
    expect(csl.to_bytes().length).toBe(tx.length / 2);
    const linear = BigInt(CSL.min_fee(csl, CSL.LinearFee.new(bn(PREPROD.minFeeA), bn(PREPROD.minFeeB))).to_str());
    const prices = CSL.ExUnitPrices.new(CSL.UnitInterval.new(bn(577), bn(10_000)), CSL.UnitInterval.new(bn(721), bn(10_000_000)));
    const script = BigInt(CSL.min_script_fee(csl, prices).to_str());
    const ref = BigInt(CSL.min_ref_script_fee(Number(refScriptsSize(ctx)), CSL.UnitInterval.new(bn(15), bn(1))).to_str());
    expect(minFee(ctx)).toBe(linear - PREPROD.minFeeA + script + ref);
  }

  it('an Evolution payment without scripts', async () => {
    const tx = await evolutionBuild((b) => b.payToAddress({ address: Address.fromBytes(hexToBytes('00' + '22'.repeat(56))), assets: Assets.fromLovelace(2_000_000n) }), address, ownEvo);
    const ctx = checkContext(tx, own);
    expect(ctx.facts.redeemers).toHaveLength(0);
    expectCslFee(tx, ctx);
    expect(rules(ctx)).toEqual([]);
  });

  it('an Evolution Plutus spend with the script in the witness set and collateral', async () => {
    const locked = lockedBy('fee-plutus');
    const tx = await evolutionBuild((b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }), address, ownEvo, { evaluator: fixedBudgetEvaluator });
    const ctx = checkContext(tx, [...own, locked.ours]);
    expect(ctx.facts.redeemers).toHaveLength(1);
    expect(refScriptsSize(ctx)).toBe(0n);
    expectCslFee(tx, ctx);
    expect(rules(ctx)).toEqual([]);
  });

  it('an Evolution Plutus spend whose script is a reference script of a reference input', async () => {
    const locked = lockedBy('fee-ref-locked');
    const holder = lockedBy('fee-ref-holder', plutus);
    const tx = await evolutionBuild((b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).readFrom({ referenceInputs: [holder.evo] }), address, ownEvo, { evaluator: fixedBudgetEvaluator });
    const ctx = checkContext(tx, [...own, locked.ours, holder.ours]);
    // The content of the Plutus byte string, without the language tag.
    expect(refScriptsSize(ctx)).toBe(BigInt(PLUTUS.length));
    expectCslFee(tx, ctx);
  });

  it('a reference script above one tier, with its fee in the minimum', async () => {
    const big = new PlutusV3.PlutusV3({ bytes: concat(Uint8Array.of(0x59, 0x75, 0x30), new Uint8Array(30_000).fill(7)) });
    const locked = lockedBy('fee-big-locked');
    const holder = lockedBy('fee-big-holder', big);
    const tx = await evolutionBuild((b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).readFrom({ referenceInputs: [holder.evo] }).attachScript({ script: plutus }), address, ownEvo, { evaluator: fixedBudgetEvaluator });
    const ctx = checkContext(tx, [...own, locked.ours, holder.ours]);
    expect(refScriptsSize(ctx)).toBe(30_003n);
    expectCslFee(tx, ctx);
  });
});

describe('reference script size', () => {
  const native = [1n, [[0n, myPay]]];
  const nativeRef = encode([0n, native] as never);
  const plutusRef = encode([3n, PLUTUS]);

  it('counts a native script by its CBOR and a Plutus script by the content of its byte string', () => {
    const holder = utxo('size-native', 5_000_000n, { scriptRef: nativeRef });
    const plutusHolder = utxo('size-plutus', 5_000_000n, { scriptRef: plutusRef });
    const ctx = checkContext(simple({ body: [[18n, outpoints(holder, plutusHolder)]] }), [A, holder, plutusHolder]);
    expect(refScriptsSize(ctx)).toBe(BigInt(encode(native as never).length + PLUTUS.length));
  });

  it('counts a TxIn in spend and reference inputs once, the same script in two UTxOs twice, collateral never', () => {
    const one = utxo('size-one', 10_000_000n, { scriptRef: plutusRef });
    const two = utxo('size-two', 5_000_000n, { scriptRef: plutusRef });
    const collateral = utxo('size-collateral', 5_000_000n, { scriptRef: plutusRef });
    const tx = simple({ inputs: [one], body: [[18n, outpoints(one, two)], [13n, outpoints(collateral)]] });
    expect(refScriptsSize(checkContext(tx, [one, two, collateral]))).toBe(BigInt(2 * PLUTUS.length));
  });

  it('adds the tiered reference script fee to the minimum fee', () => {
    const holder = utxo('size-fee', 5_000_000n, { scriptRef: plutusRef });
    const ctx = checkContext(simple({ body: [[18n, outpoints(holder)]] }), [A, holder]);
    expect(minFee(ctx)).toBe(PREPROD.minFeeA * ctx.facts.size + PREPROD.minFeeB + 15n * BigInt(PLUTUS.length));
  });
});

describe('minimum UTxO against CSL', () => {
  const policy = CSL.ScriptHash.from_bytes(hexToBytes(POLICY));
  const cases: Array<[string, (coin: CSL.BigNum) => CSL.TransactionOutput]> = [
    ['pure ADA', (coin) => CSL.TransactionOutput.new(CSL.Address.from_bytes(myAddress), CSL.Value.new(coin))],
    [
      'multi-asset',
      (coin) => {
        const assets = CSL.Assets.new();
        assets.insert(CSL.AssetName.new(hexToBytes('41')), bn(5));
        assets.insert(CSL.AssetName.new(new Uint8Array(32).fill(0x62)), bn(1_000_000_000_000));
        const multi = CSL.MultiAsset.new();
        multi.insert(policy, assets);
        multi.insert(CSL.ScriptHash.from_bytes(h(1)), assets);
        return CSL.TransactionOutput.new(CSL.Address.from_bytes(myAddress), CSL.Value.new_with_assets(coin, multi));
      },
    ],
    [
      'inline datum',
      (coin) => {
        const out = CSL.TransactionOutput.new(CSL.Address.from_bytes(myAddress), CSL.Value.new(coin));
        out.set_plutus_data(CSL.PlutusData.new_bytes(new Uint8Array(40).fill(9)));
        return out;
      },
    ],
    [
      'script ref',
      (coin) => {
        const out = CSL.TransactionOutput.new(CSL.Address.from_bytes(myAddress), CSL.Value.new(coin));
        out.set_script_ref(CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_v3(PLUTUS)));
        return out;
      },
    ],
  ];

  it.each(cases)('%s', (_name, make) => {
    const cost = CSL.DataCost.new_coins_per_byte(bn(PREPROD.coinsPerUtxoByte));
    // CSL iterates to the fixed point where the coin field has the width of its own result, so the output is rebuilt with it.
    const min = CSL.min_ada_for_output(make(bn(1)), cost);
    const outputs = CSL.TransactionOutputs.new();
    outputs.add(make(min));
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(A.input.txId), 0));
    const tx = CSL.Transaction.new(CSL.TransactionBody.new_tx_body(inputs, outputs, bn(200_000)), CSL.TransactionWitnessSet.new());
    const [output] = checkContext(tx.to_hex(), [A]).facts.outputs;
    expect(output!.output.lovelace).toBe(BigInt(min.to_str()));
    expect(minUtxo(output!, PREPROD)).toBe(BigInt(min.to_str()));
  });
});

describe('UTXO rules, each once failing and once passing', () => {
  it('the base transactions pass', () => {
    expect(rules(checkContext(simple(), [A]))).toEqual([]);
    expect(rules(checkContext(withScript(), [A, C]))).toEqual([]);
  });

  it('OutsideValidityIntervalUTxO: invalidBefore <= slot < invalidHereafter, only with a current slot', () => {
    const tx = simple({ body: [[8n, 100n], [3n, 200n]] });
    for (const slot of [100n, 199n]) expect(rules(checkContext(tx, [A], { currentSlot: slot }))).toEqual([]);
    for (const slot of [99n, 200n]) expect(rules(checkContext(tx, [A], { currentSlot: slot }))).toEqual(['OutsideValidityIntervalUTxO']);
    expect(rules(checkContext(tx, [A]))).toEqual([]);
    expect(utxoFailures(checkContext(tx, [A], { currentSlot: 200n }))[0]!.detail).toBe('{invalidBefore: SJust (SlotNo 100), invalidHereafter: SJust (SlotNo 200), slot: SlotNo 200}');
  });

  it('FeeTooSmallUTxO: one lovelace below the minimum fails, the minimum passes', () => {
    const min = minFee(checkContext(simple(), [A]));
    const at = (fee: bigint) => checkContext(simple({ fee, outputs: [{ address: myAddress, lovelace: 10_000_000n - fee }] }), [A]);
    expect(rules(at(min))).toEqual([]);
    expect(rules(at(min - 1n))).toEqual(['FeeTooSmallUTxO']);
    expect(utxoFailures(at(min - 1n))[0]!.detail).toBe(`Mismatch (RelGTEQ) {supplied: Coin ${min - 1n}, expected: Coin ${min}}`);
  });

  it('the script fee counts the declared ExUnits', () => {
    const plain = minFee(checkContext(simple(), [A]));
    const ctx = checkContext(withScript(), [A, C]);
    expect(minFee(ctx)).toBe(PREPROD.minFeeA * ctx.facts.size + PREPROD.minFeeB + 6491n);
    expect(minFee(ctx)).toBeGreaterThan(plain);
  });

  it('ScriptsNotPaidUTxO: collateral at a script address', () => {
    const scriptCollateral: Utxo = { ...C, address: scriptAddress(h(4)) };
    expect(rules(checkContext(withScript(), [A, scriptCollateral]))).toEqual(['ScriptsNotPaidUTxO']);
    expect(rules(checkContext(withScript(), [A, C]))).toEqual([]);
  });

  it('CollateralContainsNonADA: tokens in the collateral unless the return gives all of them back', () => {
    const tokens = new Map([[POLICY, new Map([['41', 3n]])]]);
    const tokenCollateral: Utxo = { ...C, assets: tokens };
    expect(rules(checkContext(withScript(), [A, tokenCollateral]))).toEqual(['CollateralContainsNonADA']);
    const returning = withScript({ body: [[16n, [myAddress, [2_000_000n, new Map([[hexToBytes(POLICY), new Map([[hexToBytes('41'), 3n]])]])]]]] });
    expect(rules(checkContext(returning, [A, tokenCollateral]))).toEqual([]);
    const partly = withScript({ body: [[16n, [myAddress, [2_000_000n, new Map([[hexToBytes(POLICY), new Map([[hexToBytes('41'), 2n]])]])]]]] });
    expect(rules(checkContext(partly, [A, tokenCollateral]))).toEqual(['CollateralContainsNonADA']);
  });

  it('InsufficientCollateral: 100 × (collateral minus return) >= collateralPercent × fee', () => {
    // fee 200000 at 150 percent needs 300000
    const at = (returned: bigint) => checkContext(withScript({ body: [[16n, [myAddress, returned]]] }), [A, C]);
    expect(rules(at(4_700_000n))).toEqual([]);
    expect(rules(at(4_700_001n))).toEqual(['InsufficientCollateral']);
    expect(utxoFailures(at(4_700_001n))[0]!.detail).toBe('{balance: DeltaCoin 299999, required: Coin 300000}');
  });

  it('IncorrectTotalCollateralField: total_collateral must equal the balance', () => {
    expect(rules(checkContext(withScript({ body: [[16n, [myAddress, 4_000_000n]], [17n, 1_000_000n]] }), [A, C]))).toEqual([]);
    expect(rules(checkContext(withScript({ body: [[16n, [myAddress, 4_000_000n]], [17n, 999_999n]] }), [A, C]))).toEqual(['IncorrectTotalCollateralField']);
  });

  it('NoCollateralInputs: redeemers without resolved collateral, an unknown collateral input counts as none', () => {
    expect(rules(checkContext(simple({ witnessSet: redeemers() }), [A]))).toEqual(expect.arrayContaining(['InsufficientCollateral', 'NoCollateralInputs']));
    expect(rules(checkContext(withScript(), [A]))).toEqual(expect.arrayContaining(['NoCollateralInputs', 'BadInputsUTxO']));
    expect(rules(checkContext(withScript(), [A, C]))).not.toContain('NoCollateralInputs');
  });

  it('the collateral checks need redeemers, the same bad collateral passes without them', () => {
    const scriptCollateral: Utxo = { ...C, address: scriptAddress(h(4)), assets: new Map([[POLICY, new Map([['41', 3n]])]]) };
    const tx = simple({ body: [[13n, outpoints(scriptCollateral)], [17n, 1n]] });
    expect(rules(checkContext(tx, [A, scriptCollateral]))).toEqual([]);
    expect(rules(checkContext(simple({ body: [[17n, 1n]] }), [A]))).toEqual([]);
  });

  it('TooManyCollateralInputs: more than maxCollateralInputs, with or without redeemers', () => {
    const four = [1, 2, 3, 4].map((i) => utxo(`many-${i}`, 5_000_000n));
    expect(rules(checkContext(simple({ body: [[13n, outpoints(...four)]] }), [A, ...four]))).toEqual(['TooManyCollateralInputs']);
    expect(rules(checkContext(simple({ body: [[13n, outpoints(...four.slice(0, 3))]] }), [A, ...four]))).toEqual([]);
  });

  it('BadInputsUTxO: spend, collateral and reference inputs the UTxO set does not hold', () => {
    const ref = utxo('bad-ref', 1_000_000n);
    const tx = simple({ body: [[18n, outpoints(ref)], [13n, outpoints(C)]] });
    expect(rules(checkContext(tx, [A, C, ref]))).toEqual([]);
    expect(rules(checkContext(tx, [A, C]))).toEqual(['BadInputsUTxO']);
    expect(rules(checkContext(tx, [A, ref]))).toEqual(['BadInputsUTxO']);
    expect(utxoFailures(checkContext(tx, [A]))[0]!.detail).toBe(`[${bytesToHex(C.input.txId)}#0, ${bytesToHex(ref.input.txId)}#0]`);
  });

  it('a missing spend input fails BadInputsUTxO and ValueNotConservedUTxO together', () => {
    const B = utxo('utxo-b', 5_000_000n);
    const tx = simple({ inputs: [A, B], outputs: [{ address: myAddress, lovelace: 14_800_000n }] });
    expect(rules(checkContext(tx, [A, B]))).toEqual([]);
    expect(rules(checkContext(tx, [A]))).toEqual(['BadInputsUTxO', 'ValueNotConservedUTxO']);
  });

  it('ValueNotConservedUTxO: consumed and produced must match, shown as values', () => {
    const tx = simple({ outputs: [{ address: myAddress, lovelace: 9_800_001n }] });
    expect(rules(checkContext(tx, [A]))).toEqual(['ValueNotConservedUTxO']);
    expect(utxoFailures(checkContext(tx, [A]))[0]!.detail).toBe('Mismatch (RelEQ) {supplied: Coin 10000000, expected: Coin 10000001}');
  });

  it('ValueNotConservedUTxO counts mint, burn, withdrawals, deposits, refunds and the donation, never the collateral return', () => {
    const tokens = new Map([[POLICY, new Map([['41', 5n]])]]);
    const withTokens: Utxo = { ...A, assets: tokens };
    const policy = hexToBytes(POLICY);
    const reward = rewardAddressBytes(0, myStake);
    const mintAndBurn = (change: bigint) =>
      simple({
        inputs: [withTokens],
        outputs: [],
        body: [
          // burn all 5 of 41, mint 2 of 42 into the output
          [1n, [[myAddress, [change, new Map([[policy, new Map([[hexToBytes('42'), 2n]])]])]]]],
          [9n, new Map([[policy, new Map([[hexToBytes('41'), -5n], [hexToBytes('42'), 2n]])]])],
          [5n, new Map([[reward, 1_000_000n]])],
          [4n, [[7n, [0n, myStake], 2_000_000n], [8n, [0n, h(9)], 2_000_000n]]],
          [22n, 1_000_000n],
          [16n, [myAddress, 1_000_000_000n]],
        ],
      });
    const registered = { ...emptyCertState(), accounts: new Map([[credentialKey({ isScript: false, hash: h(9) }), 2_000_000n]]) };
    // consumed 10 + 1 withdrawal + 2 refund = 13, produced change + 0.2 fee + 2 deposit + 1 donation
    expect(rules(checkContext(mintAndBurn(9_800_000n), [withTokens], { certState: registered }))).toEqual([]);
    expect(rules(checkContext(mintAndBurn(7_800_000n), [withTokens], { certState: registered }))).toEqual(['ValueNotConservedUTxO']);
    // Without the stored deposit the refund is 0, the node counts no refund for an unknown credential.
    expect(rules(checkContext(mintAndBurn(9_800_000n), [withTokens]))).toEqual(['ValueNotConservedUTxO']);
  });

  it('BabbageOutputTooSmallUTxO: one failure listing every output and the collateral return below its minimum', () => {
    const small = simple({ outputs: [{ address: myAddress, lovelace: 969_749n }, { address: myAddress, lovelace: 8_830_251n }], body: [[16n, [myAddress, 1n]]] });
    // [address, 1] is 61 bytes, (160 + 61) × 4310 = 952510
    const failures = utxoFailures(checkContext(small, [A]));
    expect(failures.map((f) => f.rule)).toEqual(['BabbageOutputTooSmallUTxO']);
    expect(failures[0]!.detail).toBe('[(output 0, Coin 969750), (collateral return, Coin 952510)]');
    const enough = simple({ outputs: [{ address: myAddress, lovelace: 969_750n }, { address: myAddress, lovelace: 8_830_250n }] });
    expect(rules(checkContext(enough, [A]))).toEqual([]);
  });

  it('OutputTooBigUTxO: a serialized value above maxValSize, exactly maxValSize passes', () => {
    const tokens = new Map([[POLICY, new Map([['41', 1n]])]]);
    const withTokens: Utxo = { ...A, assets: tokens };
    const tx = simple({ inputs: [withTokens], outputs: [], body: [[1n, [[myAddress, [9_800_000n, new Map([[hexToBytes(POLICY), new Map([[hexToBytes('41'), 1n]])]])]]]]] });
    const ctx = checkContext(tx, [withTokens]);
    expect(rules(ctx)).toEqual([]);
    // Counted by hand: array header 1, coin 9800000 as uint32 5, map header 1, policy id 2 + 28,
    // inner map header 1, asset name 1 + 1, quantity 1. 41 bytes.
    expect(ctx.facts.outputs[0]!.valueSize).toBe(41);
    // validateOutputTooBigUTxO refuses only above the limit, a value of exactly maxValSize passes.
    expect(rules(checkContext(tx, [withTokens], { params: { ...PREPROD, maxValSize: 41n } }))).toEqual([]);
    const limit: ProtocolParams = { ...PREPROD, maxValSize: 40n };
    expect(rules(checkContext(tx, [withTokens], { params: limit }))).toEqual(['OutputTooBigUTxO']);
  });

  it('WrongNetwork: an output or the collateral return with another network tag', () => {
    const mainnet = baseAddressBytes(1, myPay, myStake);
    expect(rules(checkContext(simple({ outputs: [{ address: mainnet, lovelace: 9_800_000n }] }), [A]))).toEqual(['WrongNetwork']);
    expect(rules(checkContext(simple({ body: [[16n, [mainnet, 1_000_000n]]] }), [A]))).toEqual(['WrongNetwork']);
    expect(rules(checkContext(simple({ outputs: [{ address: mainnet, lovelace: 9_800_000n }] }), [A], { networkId: 1 }))).toEqual([]);
  });

  it('WrongNetworkWithdrawal: a reward address with another network tag', () => {
    const at = (networkId: 0 | 1) => simple({ outputs: [{ address: myAddress, lovelace: 10_800_000n }], body: [[5n, new Map([[rewardAddressBytes(networkId, myStake), 1_000_000n]])]] });
    expect(rules(checkContext(at(0), [A]))).toEqual([]);
    expect(rules(checkContext(at(1), [A]))).toEqual(['WrongNetworkWithdrawal']);
  });

  it('WrongNetworkInTxBody: only when the body names a network', () => {
    expect(rules(checkContext(simple({ body: [[15n, 0n]] }), [A]))).toEqual([]);
    expect(rules(checkContext(simple({ body: [[15n, 1n]] }), [A]))).toEqual(['WrongNetworkInTxBody']);
    expect(utxoFailures(checkContext(simple({ body: [[15n, 1n]] }), [A]))[0]!.detail).toBe('Mismatch (RelEQ) {supplied: Mainnet, expected: Testnet}');
  });

  it('MaxTxSizeUTxO: sizeTxF above maxTxSize', () => {
    const ctx = checkContext(simple(), [A]);
    expect(rules(checkContext(simple(), [A], { params: { ...PREPROD, maxTxSize: ctx.facts.size } }))).toEqual([]);
    expect(rules(checkContext(simple(), [A], { params: { ...PREPROD, maxTxSize: ctx.facts.size - 1n } }))).toEqual(['MaxTxSizeUTxO']);
  });

  it('ExUnitsTooBigUTxO: summed memory or steps above the maximum', () => {
    expect(rules(checkContext(withScript({ witnessSet: redeemers(PREPROD.maxTxExMem, 1n) }), [A, C]))).not.toContain('ExUnitsTooBigUTxO');
    expect(rules(checkContext(withScript({ witnessSet: redeemers(PREPROD.maxTxExMem + 1n, 1n) }), [A, C]))).toContain('ExUnitsTooBigUTxO');
    expect(rules(checkContext(withScript({ witnessSet: redeemers(1n, PREPROD.maxTxExSteps + 1n) }), [A, C]))).toContain('ExUnitsTooBigUTxO');
  });

  it('failures follow the order of the Babbage UTXO rule', () => {
    const mainnet = baseAddressBytes(1, myPay, myStake);
    const tx = simple({ fee: 1n, outputs: [{ address: mainnet, lovelace: 1n }], body: [[15n, 1n], [8n, 500n]] });
    expect(rules(checkContext(tx, [], { currentSlot: 1n, params: { ...PREPROD, maxTxSize: 10n } }))).toEqual([
      'OutsideValidityIntervalUTxO',
      'FeeTooSmallUTxO',
      'BadInputsUTxO',
      'ValueNotConservedUTxO',
      'BabbageOutputTooSmallUTxO',
      'WrongNetwork',
      'WrongNetworkInTxBody',
      'MaxTxSizeUTxO',
    ]);
  });
});
