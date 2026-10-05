import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Data, PlutusV3, ScriptHash } from '@evolution-sdk/evolution';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import type { Datum, Utxo } from '../src/core/ledger.js';
import { scriptHash } from '../src/core/scripts.js';
import type { CheckContext } from '../src/host/checks/context.js';
import { PATH, type Failure } from '../src/host/checks/failure.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { collectFailures, datumFailures, redeemerFailures, scriptIntegrityFailures } from '../src/host/checks/plutus-rules.js';
import { expectedScriptDataHash } from '../src/host/checks/script-integrity.js';
import { DEFAULT_COST_MODELS } from '../src/host/cost-models.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { buildTx, redeemerMap, TEST_ADDRESS } from './helpers/build-tx.js';
import { checkContext, paramsWith, type CheckOptions } from './helpers/check-context.js';
import { evolutionBuild, evolutionLocked, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { inlineDatum, lockedUtxo } from './helpers/plutus-spend.js';
import { hash28, scriptAddress, syntheticInput } from './helpers/synthetic.js';

const V3 = plutusScript('v3_always_succeeds');
const V2 = plutusScript('v2_always_succeeds');
const V1 = plutusScript('v1_always_succeeds');
const V3_HASH = V3.hash;
const V2_HASH = V2.hash;
const V1_HASH = V1.hash;

const own: Utxo = { input: syntheticInput('rules-own', 0n), address: TEST_ADDRESS, lovelace: 50_000_000n };
const datumHash = (cbor: Uint8Array) => blake2b(cbor, { dkLen: 32 });
const DATUM = encode(42n);
const DATUM_VALUE = 42n;
const DATUM_HASH = bytesToHex(datumHash(DATUM));
const OTHER_DATUM = encode(43n);
const OTHER_VALUE = 43n;
const OTHER_HASH = bytesToHex(datumHash(OTHER_DATUM));
const locked = (seed: string, hash: Uint8Array, datum?: Datum): Utxo => lockedUtxo({ hash }, seed, datum);
const byHash = (cbor: Uint8Array): Datum => ({ kind: 'hash', hash: datumHash(cbor) });
const inline = inlineDatum(1n);
const outpoint = (u: Utxo) => `${bytesToHex(u.input.txId)}#${u.input.index}`;

interface PlutusTx {
  inputs?: Utxo[];
  body?: Array<[bigint, unknown]>;
  plutusV1?: boolean;
  plutusV2?: boolean;
  plutusV3?: boolean;
  /** Witness datums as their integer values, written as a tag 258 set. */
  datums?: bigint[];
  redeemers?: Array<[bigint, bigint]>;
}

function plutusTx(opts: PlutusTx, scriptDataHash?: Uint8Array): string {
  const witnessSet = new Map<bigint, unknown>();
  if (opts.plutusV1) witnessSet.set(3n, [V1.bytes]);
  if (opts.plutusV2) witnessSet.set(6n, [V2.bytes]);
  if (opts.plutusV3) witnessSet.set(7n, [V3.bytes]);
  if (opts.datums?.length) witnessSet.set(4n, new Tagged(258n, opts.datums));
  if (opts.redeemers?.length) witnessSet.set(5n, redeemerMap(...opts.redeemers));
  const body = new Map(opts.body ?? []);
  if (scriptDataHash) body.set(11n, scriptDataHash);
  return buildTx({ inputs: (opts.inputs ?? [own]).map((u) => u.input), outputs: [], fee: 200_000n, extraBodyEntries: body, witnessSet });
}

/** The context of the transaction with body key 11 set to the hash the rules expect, so only the rule under test fails. */
function consistent(opts: PlutusTx, unspent: Utxo[], options: CheckOptions = {}): CheckContext {
  const draft = checkContext(plutusTx(opts), unspent, options);
  return checkContext(plutusTx(opts, expectedScriptDataHash(draft, plutusNeeds(draft))), unspent, options);
}
/** The three UTXOW Plutus rules in the order witnessFailures runs them, without the VKey and metadata rules between them. */
const witness = (ctx: CheckContext) => {
  const needs = plutusNeeds(ctx);
  return [...datumFailures(ctx, needs), ...redeemerFailures(ctx, needs), ...scriptIntegrityFailures(ctx, needs)];
};
const collect = (ctx: CheckContext) => collectFailures(ctx, plutusNeeds(ctx));
const utxow = (rule: string, detail: string): Failure => ({ path: PATH.UTXOW, rule, detail });
/** CollectErrors holds a NonEmpty, written 'x :| [y]'. */
const collectErrors = (first: string, ...rest: string[]): Failure[] => [{ path: PATH.UTXOS, rule: 'CollectErrors', detail: `${first} :| [${rest.join(', ')}]` }];

describe('consistent Plutus transactions pass both phases', () => {
  it('a V3 spend with an inline datum built by Evolution', async () => {
    const plutus = new PlutusV3.PlutusV3({ bytes: V3.bytes });
    const spent = locked('rules-evolution', V3_HASH, inline);
    const lockedEvo = evolutionLocked(spent, ScriptHash.fromScript(plutus), Data.int(1n));
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [lockedEvo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      TEST_ADDRESS,
      [evolutionUtxo(own, TEST_ADDRESS)],
      { evaluator: fixedBudgetEvaluator },
    );
    const ctx = checkContext(tx, [own, spent]);
    expect(plutusNeeds(ctx)).toHaveLength(1);
    expect(witness(ctx)).toEqual([]);
    expect(collect(ctx)).toEqual([]);
  });

  it('a V2 spend with a datum hash and its witness datum built by CSL', () => {
    const script = CSL.PlutusScript.from_bytes_with_version(CSL.PlutusData.new_bytes(V2.bytes).to_bytes(), CSL.Language.new_plutus_v2());
    const datum = CSL.PlutusData.from_bytes(DATUM);
    const spent = locked('rules-csl', V2_HASH, byHash(DATUM));
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(spent.input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), CSL.BigNum.from_str('400000'));
    const witnesses = CSL.TransactionWitnessSet.new();
    const scripts = CSL.PlutusScripts.new();
    scripts.add(script);
    witnesses.set_plutus_scripts(scripts);
    const datums = CSL.PlutusList.new();
    datums.add(datum);
    witnesses.set_plutus_data(datums);
    const redeemers = CSL.Redeemers.new();
    redeemers.add(CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), CSL.BigNum.zero(), CSL.PlutusData.new_empty_constr_plutus_data(CSL.BigNum.zero()), CSL.ExUnits.new(CSL.BigNum.from_str('1700'), CSL.BigNum.from_str('256100'))));
    witnesses.set_redeemers(redeemers);
    const costModels = CSL.Costmdls.new();
    const model = CSL.CostModel.new();
    DEFAULT_COST_MODELS.PlutusV2.forEach((p, i) => model.set(i, CSL.Int.from_str(p.toString())));
    costModels.insert(CSL.Language.new_plutus_v2(), model);
    body.set_script_data_hash(CSL.hash_script_data(redeemers, costModels, datums));
    const ctx = checkContext(CSL.Transaction.new(body, witnesses).to_hex(), [spent]);
    expect(witness(ctx)).toEqual([]);
    expect(collect(ctx)).toEqual([]);
  });
});

describe('datums', () => {
  it('UnspendableUTxONoDatumHash: a V2 script input without a datum, never a V3 one (CIP-69)', () => {
    const v2 = locked('rules-no-datum-v2', V2_HASH);
    const v3 = locked('rules-no-datum-v3', V3_HASH);
    const ctx = consistent({ inputs: [v2, v3], plutusV2: true, plutusV3: true, redeemers: [[0n, 0n], [0n, 1n]] }, [v2, v3]);
    expect(witness(ctx)).toEqual([utxow('UnspendableUTxONoDatumHash', `[${outpoint(v2)}]`)]);
    const onlyV3 = consistent({ inputs: [v3], plutusV3: true, redeemers: [[0n, 0n]] }, [v3]);
    expect(witness(onlyV3)).toEqual([]);
  });

  it('a script input without a datum whose script is not provided is left to MissingScriptWitnessesUTXOW', () => {
    const v2 = locked('rules-unprovided', V2_HASH);
    expect(witness(consistent({ inputs: [v2] }, [v2]))).toEqual([]);
  });

  it('MissingRequiredDatums: a datum hash without its datum, V3 included, with every datum received', () => {
    const v3 = locked('rules-missing-datum', V3_HASH, byHash(DATUM));
    // OTHER_DATUM is allowed through the datum hash of an output.
    const body: Array<[bigint, unknown]> = [[1n, [[TEST_ADDRESS, 1_000_000n, datumHash(OTHER_DATUM)]]]];
    const ctx = consistent({ inputs: [v3], body, plutusV3: true, datums: [OTHER_VALUE], redeemers: [[0n, 0n]] }, [v3]);
    expect(witness(ctx)).toEqual([utxow('MissingRequiredDatums', `{missing: [${DATUM_HASH}], received: [${OTHER_HASH}]}`)]);
    expect(witness(consistent({ inputs: [v3], body, plutusV3: true, datums: [DATUM_VALUE, OTHER_VALUE], redeemers: [[0n, 0n]] }, [v3]))).toEqual([]);
  });

  it('NotAllowedSupplementalDatums: a datum nothing names, the allowed ones listed beside it', () => {
    const v3 = locked('rules-supplemental', V3_HASH, inline);
    const body: Array<[bigint, unknown]> = [[1n, [[TEST_ADDRESS, 1_000_000n, datumHash(OTHER_DATUM)]]]];
    const ctx = consistent({ inputs: [v3], body, plutusV3: true, datums: [DATUM_VALUE, OTHER_VALUE], redeemers: [[0n, 0n]] }, [v3]);
    expect(witness(ctx)).toEqual([utxow('NotAllowedSupplementalDatums', `{unallowed: [${DATUM_HASH}], acceptable: [${OTHER_HASH}]}`)]);
  });

  it('allows a supplemental datum named by an output, the collateral return or a reference input, never by an inline datum', () => {
    const v3 = locked('rules-allowed', V3_HASH, inline);
    const reference: Utxo = { input: syntheticInput('rules-reference', 0n), address: TEST_ADDRESS, lovelace: 2_000_000n, datum: byHash(DATUM) };
    const allowedBy: Array<[string, Array<[bigint, unknown]>, Utxo[]]> = [
      ['an output', [[1n, [[TEST_ADDRESS, 1_000_000n, datumHash(DATUM)]]]], []],
      ['the collateral return', [[16n, [TEST_ADDRESS, 1_000_000n, datumHash(DATUM)]]], []],
      ['a reference input', [[18n, new Tagged(258n, [[reference.input.txId, 0n]])]], [reference]],
    ];
    for (const [, body, extra] of allowedBy) {
      expect(witness(consistent({ inputs: [v3], body, plutusV3: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n]] }, [v3, ...extra]))).toEqual([]);
    }
    // An output with the same datum inline names no datum hash.
    const inlineOutput: Array<[bigint, unknown]> = [[1n, [new Map<bigint, unknown>([[0n, TEST_ADDRESS], [1n, 1_000_000n], [2n, [1n, new Tagged(24n, DATUM)]]])]]];
    const rules = witness(consistent({ inputs: [v3], body: inlineOutput, plutusV3: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n]] }, [v3])).map((f) => f.rule);
    expect(rules).toEqual(['NotAllowedSupplementalDatums']);
  });
});

describe('redeemers', () => {
  const v3 = locked('rules-redeemers', V3_HASH, inline);

  it('ExtraRedeemers: pointers nothing needs, by tag and index whatever the wire order', () => {
    const native = [1n, []];
    const nativeLocked = locked('rules-native', scriptHash(0, encode(native as never)));
    const ctx = consistent({ inputs: [v3, nativeLocked], plutusV3: true, redeemers: [[1n, 0n], [0n, 1n], [0n, 0n]] }, [v3, nativeLocked]);
    // The native script spend needs no redeemer and the transaction mints nothing.
    const index = (u: Utxo) => [v3, nativeLocked].map((x) => bytesToHex(x.input.txId)).sort().indexOf(bytesToHex(u.input.txId));
    expect(plutusNeeds(ctx).map((n) => n.index)).toEqual([BigInt(index(v3))]);
    expect(witness(ctx)).toEqual([utxow('ExtraRedeemers', `[ConwaySpending (AsIx ${index(nativeLocked)}), ConwayMinting (AsIx 0)]`)]);
  });

  it('MissingRedeemers: every need without a redeemer, in need order, with its script hash', () => {
    const mint: Array<[bigint, unknown]> = [[9n, new Map([[V2_HASH, new Map([[hexToBytes('41'), 1n]])]])]];
    const ctx = consistent({ inputs: [v3], body: mint, plutusV2: true, plutusV3: true }, [v3]);
    expect(witness(ctx)).toEqual([utxow('MissingRedeemers', `[(ConwaySpending (AsIx 0), ${V3.hashHex}), (ConwayMinting (AsIx 0), ${V2.hashHex})]`)]);
  });

  it('reports ExtraRedeemers before MissingRedeemers', () => {
    const ctx = consistent({ inputs: [v3], plutusV3: true, redeemers: [[0n, 1n]] }, [v3]);
    expect(witness(ctx).map((f) => f.rule)).toEqual(['ExtraRedeemers', 'MissingRedeemers']);
  });
});

describe('script integrity hash', () => {
  const v3 = locked('rules-integrity', V3_HASH, inline);
  const opts: PlutusTx = { inputs: [v3], plutusV3: true, redeemers: [[0n, 0n]] };

  it('ScriptIntegrityHashMismatch: a wrong hash, a missing one and one that must be absent', () => {
    const draft = checkContext(plutusTx(opts), [v3]);
    const expected = bytesToHex(expectedScriptDataHash(draft, plutusNeeds(draft))!);
    const wrong = new Uint8Array(32).fill(1);
    expect(witness(checkContext(plutusTx(opts, wrong), [v3]))).toEqual([
      utxow('ScriptIntegrityHashMismatch', `Mismatch (RelEQ) {supplied: SJust ${bytesToHex(wrong)}, expected: SJust ${expected}}`),
    ]);
    expect(witness(checkContext(plutusTx(opts), [v3]))).toEqual([utxow('ScriptIntegrityHashMismatch', `Mismatch (RelEQ) {supplied: SNothing, expected: SJust ${expected}}`)]);
    const plain = checkContext(plutusTx({}, wrong), [own]);
    expect(witness(plain)).toEqual([utxow('ScriptIntegrityHashMismatch', `Mismatch (RelEQ) {supplied: SJust ${bytesToHex(wrong)}, expected: SNothing}`)]);
  });

  it('a hash made for other cost models fails', () => {
    const ctx = consistent(opts, [v3], { params: paramsWith({ PlutusV3: [1n, 2n, 3n] }) });
    expect(witness(ctx)).toEqual([]);
    expect(witness(checkContext(plutusTx(opts, ctx.facts.scriptDataHash), [v3])).map((f) => f.rule)).toEqual(['ScriptIntegrityHashMismatch']);
  });

  it('reports datum, redeemer and integrity failures of one transaction side by side', () => {
    const v2 = locked('rules-order', V2_HASH);
    const ctx = checkContext(plutusTx({ inputs: [v2], plutusV2: true, datums: [DATUM_VALUE], redeemers: [[1n, 0n]] }), [v2]);
    expect(witness(ctx).map((f) => f.rule)).toEqual([
      'UnspendableUTxONoDatumHash',
      'NotAllowedSupplementalDatums',
      'ExtraRedeemers',
      'MissingRedeemers',
      'ScriptIntegrityHashMismatch',
    ]);
  });
});

describe('collect phase', () => {
  const v3 = locked('rules-collect', V3_HASH, inline);
  const mintV2: Array<[bigint, unknown]> = [[9n, new Map([[V2_HASH, new Map([[hexToBytes('41'), 1n]])]])]];

  it('is empty when every needed script has a redeemer and a context the ledger can build', () => {
    expect(collect(consistent({ inputs: [v3], body: mintV2, plutusV2: true, plutusV3: true, redeemers: [[0n, 0n], [1n, 0n]] }, [v3]))).toEqual([]);
  });

  it('NoRedeemer for every script without one, the later first, beside MissingRedeemers', () => {
    const ctx = consistent({ inputs: [v3], body: mintV2, plutusV2: true, plutusV3: true }, [v3]);
    expect(collect(ctx)).toEqual(collectErrors('NoRedeemer (ConwayMinting (AsIx 0))', 'NoRedeemer (ConwaySpending (AsIx 0))'));
    expect(witness(ctx).map((f) => f.rule)).toEqual(['MissingRedeemers']);
  });

  it('a reward and a mint without redeemers: MissingRedeemers in need order, NoRedeemer the later first, whatever the body order', () => {
    // Body key 9 before key 5, the needs still come reward before mint (Conway UTxO.hs getConwayScriptsNeeded).
    const withdrawal: Array<[bigint, unknown]> = [[5n, new Map([[concat(Uint8Array.of(0xf0), V3_HASH), 0n]])]];
    const ctx = consistent({ body: [...mintV2, ...withdrawal], plutusV2: true, plutusV3: true }, [own]);
    expect(witness(ctx)).toEqual([utxow('MissingRedeemers', `[(ConwayRewarding (AsIx 0), ${V3.hashHex}), (ConwayMinting (AsIx 0), ${V2.hashHex})]`)]);
    expect(collect(ctx)).toEqual(collectErrors('NoRedeemer (ConwayMinting (AsIx 0))', 'NoRedeemer (ConwayRewarding (AsIx 0))'));
  });

  it('merges like the node: a translation failure stays behind a later NoRedeemer, one after an error is never seen', () => {
    const shared: Array<[bigint, unknown]> = [[18n, new Tagged(258n, [[v3.input.txId, 0n]])]];
    const mintV3: Array<[bigint, unknown]> = [[9n, new Map([[V3_HASH, new Map([[hexToBytes('41'), 1n]])]])]];
    const badTranslation = `BadTranslation (ReferenceInputsNotDisjointFromInputs (${outpoint(v3)} :| []))`;
    // Spend first: its translation fails, then the mint has no redeemer.
    expect(collect(consistent({ inputs: [v3], body: [...shared, ...mintV2], plutusV2: true, plutusV3: true, redeemers: [[0n, 0n]] }, [v3]))).toEqual(
      collectErrors('NoRedeemer (ConwayMinting (AsIx 0))', badTranslation),
    );
    // Spend without a redeemer first: the translation of the V3 mint is never looked at.
    expect(collect(consistent({ inputs: [v3], body: [...shared, ...mintV3], plutusV3: true, redeemers: [[1n, 0n]] }, [v3]))).toEqual(
      collectErrors('NoRedeemer (ConwaySpending (AsIx 0))'),
    );
    // Both redeemers present: only the first translation failure.
    expect(collect(consistent({ inputs: [v3], body: [...shared, ...mintV3], plutusV3: true, redeemers: [[0n, 0n], [1n, 0n]] }, [v3]))).toEqual(collectErrors(badTranslation));
  });

  it('BadTranslation for a V3 script when a spend input is also a reference input, from protocol 11 on, never for V2 alone', () => {
    const asReference: Array<[bigint, unknown]> = [[18n, new Tagged(258n, [[v3.input.txId, 0n]])]];
    const ctx = consistent({ inputs: [v3], body: asReference, plutusV3: true, redeemers: [[0n, 0n]] }, [v3]);
    expect(collect(ctx)).toEqual(collectErrors(`BadTranslation (ReferenceInputsNotDisjointFromInputs (${outpoint(v3)} :| []))`));
    const protocol10 = { params: { ...DEFAULT_PROTOCOL_PARAMS[0], protocolMajorVersion: 10n } };
    expect(collect(consistent({ inputs: [v3], body: asReference, plutusV3: true, redeemers: [[0n, 0n]] }, [v3], protocol10))).toEqual([]);
    const v2 = locked('rules-collect-v2', V2_HASH, byHash(DATUM));
    const v2Reference: Array<[bigint, unknown]> = [[18n, new Tagged(258n, [[v2.input.txId, 0n]])]];
    expect(collect(consistent({ inputs: [v2], body: v2Reference, plutusV2: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n]] }, [v2]))).toEqual([]);
  });
});

describe('collect phase: script contexts the ledger cannot build', () => {
  const mint = (hash: Uint8Array): Array<[bigint, unknown]> => [[9n, new Map([[hash, new Map([[hexToBytes('41'), 1n]])]])]];
  const inlineOutput = (lovelace: bigint) => new Map<bigint, unknown>([[0n, TEST_ADDRESS], [1n, lovelace], [2n, [1n, new Tagged(24n, DATUM)]]]);
  const v1Spend = locked('rules-v1-spend', V1_HASH, byHash(DATUM));
  const v1Opts: PlutusTx = { inputs: [v1Spend], plutusV1: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n]] };
  const inlineDatums = (source: string) => `BadTranslation (BabbageContextError (InlineDatumsNotSupported (${source})))`;

  it('PlutusV1 sees no inline datum: a spend input, then a reference input, then an output, V2 and V3 see them', () => {
    const v1Inline = locked('rules-v1-inline', V1_HASH, inline);
    expect(witness(consistent({ ...v1Opts, inputs: [v1Inline], datums: [] }, [v1Inline]))).toEqual([]);
    expect(collect(consistent({ ...v1Opts, inputs: [v1Inline], datums: [] }, [v1Inline]))).toEqual(collectErrors(inlineDatums(`TxOutFromInput ${outpoint(v1Inline)}`)));

    const reference: Utxo = { input: syntheticInput('rules-v1-reference', 0n), address: TEST_ADDRESS, lovelace: 2_000_000n, datum: inline };
    const withReference: Array<[bigint, unknown]> = [[18n, new Tagged(258n, [[reference.input.txId, 0n]])]];
    expect(collect(consistent({ ...v1Opts, body: withReference }, [v1Spend, reference]))).toEqual(collectErrors(inlineDatums(`TxOutFromInput ${outpoint(reference)}`)));

    // The second output carries the inline datum, the first a plain coin.
    const outputs: Array<[bigint, unknown]> = [[1n, [[TEST_ADDRESS, 1_000_000n], inlineOutput(1_000_000n)]]];
    expect(collect(consistent({ ...v1Opts, body: outputs }, [v1Spend]))).toEqual(collectErrors(inlineDatums('TxOutFromOutput (TxIx 1)')));
    // The input comes before the reference input and the output.
    expect(collect(consistent({ ...v1Opts, inputs: [v1Inline], datums: [], body: [...withReference, ...outputs] }, [v1Inline, reference]))).toEqual(
      collectErrors(inlineDatums(`TxOutFromInput ${outpoint(v1Inline)}`)),
    );

    // The same transactions with a V2 or V3 script, and a collateral return with an inline datum under V1.
    const v2Spend = locked('rules-v2-spend', V2_HASH, byHash(DATUM));
    expect(collect(consistent({ inputs: [v2Spend], plutusV2: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n]], body: [...withReference, ...outputs] }, [v2Spend, reference]))).toEqual([]);
    const v3Spend = locked('rules-v3-spend', V3_HASH, inline);
    expect(collect(consistent({ inputs: [v3Spend], plutusV3: true, redeemers: [[0n, 0n]], body: [...withReference, ...outputs] }, [v3Spend, reference]))).toEqual([]);
    expect(collect(consistent({ ...v1Opts, body: [[16n, inlineOutput(1_000_000n)]] }, [v1Spend]))).toEqual([]);
  });

  it('PlutusV1 and V2 refuse votes, proposals, a treasury donation and the current treasury, in that order', () => {
    // A DRep key votes, no script is needed for it.
    const drepKey = hash28(5);
    const voters: Array<[bigint, unknown]> = [[19n, new Map([[[2n, drepKey], new Map([[[new Uint8Array(32), 0n], [1n, null]]])]])]];
    const proposals: Array<[bigint, unknown]> = [[20n, [[100_000_000_000n, concat(Uint8Array.of(0xe0), V2_HASH), [6n], [`https://example.com/a.json`, new Uint8Array(32)]]]]];
    const donation: Array<[bigint, unknown]> = [[22n, 5n]];
    const treasury: Array<[bigint, unknown]> = [[21n, 10n]];
    const opts = (body: Array<[bigint, unknown]>): PlutusTx => ({ body: [...mint(V2_HASH), ...body], plutusV2: true, redeemers: [[1n, 0n]] });
    expect(collect(consistent(opts([...treasury, ...donation, ...proposals, ...voters]), [own]))).toEqual(
      collectErrors(`BadTranslation (VotingProceduresFieldNotSupported [DRepVoter ${bytesToHex(drepKey)}])`),
    );
    expect(collect(consistent(opts([...treasury, ...donation, ...proposals]), [own]))).toEqual(collectErrors('BadTranslation (ProposalProceduresFieldNotSupported [InfoAction])'));
    expect(collect(consistent(opts([...treasury, ...donation]), [own]))).toEqual(collectErrors('BadTranslation (TreasuryDonationFieldNotSupported (Coin 5))'));
    expect(collect(consistent(opts(treasury), [own]))).toEqual(collectErrors('BadTranslation (CurrentTreasuryFieldNotSupported (Coin 10))'));
    // The same fields under a V3 mint.
    expect(collect(consistent({ body: [...mint(V3_HASH), ...treasury, ...donation, ...proposals, ...voters], plutusV3: true, redeemers: [[1n, 0n]] }, [own]))).toEqual([]);
  });

  it('a V2 script that votes meets the guard first, PlutusPurposeNotSupported comes after it and never shows', () => {
    const voters: Array<[bigint, unknown]> = [[19n, new Map([[[3n, V2_HASH], new Map([[[new Uint8Array(32), 0n], [1n, null]]])]])]];
    const ctx = consistent({ body: voters, plutusV2: true, redeemers: [[4n, 0n]] }, [own]);
    expect(plutusNeeds(ctx).map((n) => n.purpose)).toEqual(['ConwayVoting (AsIx 0)']);
    expect(collect(ctx)).toEqual(collectErrors(`BadTranslation (VotingProceduresFieldNotSupported [DRepVoter ${V2.hashHex}])`));
  });

  it('PlutusV1 and V2 translate certificates 0, 1, 2, 3, 4, 7 and 8 only, V3 every one', () => {
    const key = [0n, hash28(7)];
    const translatable = [
      [0n, key],
      [1n, key],
      [2n, key, hash28(8)],
      [4n, hash28(9), 300n],
      [7n, key, 2_000_000n],
      [8n, key, 2_000_000n],
    ];
    const certs = (...list: unknown[]): Array<[bigint, unknown]> => [[4n, list]];
    const v2 = (body: Array<[bigint, unknown]>): PlutusTx => ({ body: [...mint(V2_HASH), ...body], plutusV2: true, redeemers: [[1n, 0n]] });
    expect(collect(consistent(v2(certs(...translatable)), [own]))).toEqual([]);
    expect(collect(consistent(v2(certs(...translatable, [9n, key, [2n]], [17n, key, 500_000_000n])), [own]))).toEqual(
      collectErrors('BadTranslation (CertificateNotSupported (certificate 9 (delegation_to_drep)))'),
    );
    const v1Mint: PlutusTx = { body: [...mint(V1_HASH), ...certs([16n, key, 500_000_000n, null])], plutusV1: true, redeemers: [[1n, 0n]] };
    expect(collect(consistent(v1Mint, [own]))).toEqual(collectErrors('BadTranslation (CertificateNotSupported (certificate 16 (drep_registration)))'));
    expect(collect(consistent({ body: [...mint(V3_HASH), ...certs(...translatable, [9n, key, [2n]], [17n, key, 500_000_000n])], plutusV3: true, redeemers: [[1n, 0n]] }, [own]))).toEqual([]);
  });

  it('mixed languages: a V1 context the ledger cannot build is reported whether its script comes first or second', () => {
    // An output with an inline datum, which only PlutusV1 cannot see. The V3 input has no datum (CIP-69), the V1
    // context shows every spend input and would refuse an inline one there first. Explicit tx ids put either script first.
    const at = (fill: number, hash: Uint8Array, datum?: Datum): Utxo => ({ input: { txId: new Uint8Array(32).fill(fill), index: 0n }, address: scriptAddress(hash), lovelace: 5_000_000n, ...(datum ? { datum } : {}) });
    const outputs: Array<[bigint, unknown]> = [[1n, [inlineOutput(2_000_000n)]]];
    const expected = collectErrors(inlineDatums('TxOutFromOutput (TxIx 0)'));
    for (const [v3Fill, v1Fill] of [
      [0x01, 0xfe],
      [0xfe, 0x01],
    ] as const) {
      const v3 = at(v3Fill, V3_HASH);
      const v1 = at(v1Fill, V1_HASH, byHash(DATUM));
      const ctx = consistent({ inputs: [v3, v1], body: outputs, plutusV1: true, plutusV3: true, datums: [DATUM_VALUE], redeemers: [[0n, 0n], [0n, 1n]] }, [v3, v1]);
      expect(plutusNeeds(ctx).map((n) => n.language)).toEqual(v3Fill < v1Fill ? [3, 1] : [1, 3]);
      expect(witness(ctx)).toEqual([]);
      expect(collect(ctx)).toEqual(expected);
    }
  });
});
