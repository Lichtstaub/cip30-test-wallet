// Phase 2 with the real compiled scripts of test/fixtures/plutus: scalus runs
// them, the wallet compares the result with the declared ExUnits and the
// is_valid flag. @lucid-evolution/uplc (aiken's evaluator) is the second oracle
// for the computed ExUnits.
import { createRequire } from 'node:module';
import { blake2b } from '@noble/hashes/blake2.js';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { decode, type CborValue } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { ChwError } from '../src/core/errors.js';
import { encodeOutput, type Datum, type Utxo } from '../src/core/ledger.js';
import type { CheckContext } from '../src/host/checks/context.js';
import { renderFailure } from '../src/host/checks/failure.js';
import { evaluateScripts, phaseTwoFailures, type EvaluationOutcome } from '../src/host/checks/phase-two.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { collectFailures } from '../src/host/checks/plutus-rules.js';
import { DEFAULT_COST_MODELS } from '../src/host/cost-models.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { SLOT_CONFIGS, type CardanoNetwork } from '../src/host/slot-config.js';
import { checkContext } from './helpers/check-context.js';
import { PLUTUS_FIXTURE_NAMES, plutusScript, type PlutusFixture, type PlutusFixtureName } from './helpers/plutus-fixtures.js';
import { inlineDatum, lockedUtxo, myWallet, plutusSpend, UNIT_DATA, type PlutusSpendOptions } from './helpers/plutus-spend.js';
import { hash28 } from './helpers/synthetic.js';

const { myAddress, wallet } = myWallet('phase-two-wallet');
const SIGNER = hash28(0x22);

const ALWAYS_SUCCEEDS = plutusScript('v3_always_succeeds');
const ALWAYS_FAILS = plutusScript('v3_always_fails_traced');
/** Constr 0 [] behind its datum hash, for V1 and V2, which cannot see an inline datum. */
const UNIT_DATUM_HASH: Datum = { kind: 'hash', hash: blake2b(encode(UNIT_DATA), { dkLen: 32 }) };

/** One script spend of a fresh output plus the wallet UTxO, as the node would see it. */
function spendOf(script: PlutusFixture, opts: Partial<PlutusSpendOptions> & { datum?: Utxo['datum']; redeemer?: CborValue; exUnits?: { mem: bigint; steps: bigint }; network?: CardanoNetwork } = {}) {
  const { datum, redeemer, exUnits, network, ...rest } = opts;
  const locked = lockedUtxo(script, `phase-two-${script.name}`, datum);
  const tx = plutusSpend({ spends: [{ utxo: locked, script, ...(redeemer ? { redeemer } : {}), ...(exUnits ? { exUnits } : {}) }], wallet, changeAddress: myAddress, ...rest });
  const ctx = checkContext(tx, [wallet, locked], network ? { slotConfig: SLOT_CONFIGS[network] } : {});
  return { ctx, needs: plutusNeeds(ctx), locked };
}

async function judge(ctx: CheckContext): Promise<{ outcome: EvaluationOutcome; rendered: string[] }> {
  const needs = plutusNeeds(ctx);
  const outcome = await evaluateScripts(ctx, needs);
  return { outcome, rendered: phaseTwoFailures(ctx, needs, outcome).map(renderFailure) };
}

const FAILED = /^ConwayUtxowFailure \(UtxoFailure \(UtxosFailure \(ValidationTagMismatch \(IsValid True\) \(FailedUnexpectedly \(PlutusFailure "\\nThe PlutusV3 script failed:\\n.*" "" :\| \[\]\)\)\)\)\)$/;

describe('evaluateScripts and phaseTwoFailures', () => {
  it('always_succeeds passes with the ExUnits it computes', async () => {
    const { ctx, needs } = spendOf(ALWAYS_SUCCEEDS);
    const { outcome, rendered } = await judge(ctx);
    expect(outcome).toEqual({ kind: 'passed', runs: [{ tag: 0n, index: needs[0]!.index, mem: 9751n, steps: 2836913n }] });
    expect(rendered).toEqual([]);
  });

  it('always_fails is FailedUnexpectedly naming the language, the script hash, the scalus code and the trace', async () => {
    const { ctx, needs } = spendOf(ALWAYS_FAILS);
    const { outcome, rendered } = await judge(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', need: needs[0], code: 'SCRIPT_FAILURE', logs: ['oracle: always fails'] });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatch(FAILED);
    expect(rendered[0]).toContain(
      `"\\nThe PlutusV3 script failed:\\nThe script hash is:ScriptHash \\"d4bbe572041c0f9338d12db725b6caacc991dccd0c08aefb95d56278\\"\\nThe plutus evaluation error is: SCRIPT_FAILURE: Spend[${needs[0]!.index}] failed: Error evaluated\\nThe script traces are:\\noracle: always fails\\n" ""`,
    );
  });

  it('declared ExUnits below what always_succeeds needs is FailedUnexpectedly, exactly enough passes', async () => {
    const short = spendOf(ALWAYS_SUCCEEDS, { exUnits: { mem: 9_750n, steps: 2_836_913n } });
    const { outcome, rendered } = await judge(short.ctx);
    // scalus ran with maxTxExUnits and passed, the comparison per redeemer fails it.
    expect(outcome.kind).toBe('passed');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatch(FAILED);
    expect(rendered[0]).toContain(
      `OUT_OF_BUDGET: ConwaySpending (AsIx ${short.needs[0]!.index}) needs ExUnits {mem: 9751, steps: 2836913}, its redeemer declares ExUnits {mem: 9750, steps: 2836913}`,
    );
    expect((await judge(spendOf(ALWAYS_SUCCEEDS, { exUnits: { mem: 9_751n, steps: 2_836_912n } }).ctx)).rendered).toHaveLength(1);
    expect((await judge(spendOf(ALWAYS_SUCCEEDS, { exUnits: { mem: 9_751n, steps: 2_836_913n } }).ctx)).rendered).toEqual([]);
  });

  it('is_valid false with a failing script is consistent, the node takes the collateral', async () => {
    const { ctx } = spendOf(ALWAYS_FAILS, { isValid: false });
    expect((await judge(ctx)).rendered).toEqual([]);
    // Under-declared ExUnits fail the script as well.
    expect((await judge(spendOf(ALWAYS_SUCCEEDS, { isValid: false, exUnits: { mem: 1n, steps: 1n } }).ctx)).rendered).toEqual([]);
  });

  it('is_valid false with every script passing is PassedUnexpectedly', async () => {
    const { ctx } = spendOf(ALWAYS_SUCCEEDS, { isValid: false });
    expect((await judge(ctx)).rendered).toEqual(['ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))']);
  });

  it('is_valid false without any script is PassedUnexpectedly, nothing runs', async () => {
    const tx = plutusSpend({ spends: [], wallet, changeAddress: myAddress, isValid: false });
    const ctx = checkContext(tx, [wallet]);
    const outcome = await evaluateScripts(ctx, []);
    expect(outcome).toEqual({ kind: 'passed', runs: [] });
    expect(phaseTwoFailures(ctx, [], outcome).map(renderFailure)).toEqual(['ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))']);
  });

  it('two failing scripts: the node names both, the wallet the first scalus meets', async () => {
    const first = lockedUtxo(ALWAYS_FAILS, 'phase-two-two-a');
    const second = lockedUtxo(ALWAYS_FAILS, 'phase-two-two-b');
    const tx = plutusSpend({ spends: [{ utxo: first, script: ALWAYS_FAILS }, { utxo: second, script: ALWAYS_FAILS }], wallet, changeAddress: myAddress });
    const { rendered } = await judge(checkContext(tx, [wallet, first, second]));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.match(/PlutusFailure/g)).toHaveLength(1);
  });

  it('needs_signer passes with the datum key among the required signers and fails without it', async () => {
    const script = plutusScript('v3_needs_signer');
    const datum = inlineDatum(SIGNER);
    expect((await judge(spendOf(script, { datum, requiredSigners: [SIGNER] }).ctx)).rendered).toEqual([]);
    const without = await judge(spendOf(script, { datum }).ctx);
    expect(without.outcome).toMatchObject({ kind: 'failed', code: 'SCRIPT_FAILURE' });
    expect(without.rendered[0]).toMatch(FAILED);
  });

  // The script compares the start of the validity interval with the deadline in its datum, in POSIX
  // milliseconds. A preview slot starts about 127 days later than the same preprod slot, so a deadline
  // taken from the preview calendar is not yet reached when the wallet reads the slot with the
  // preprod calendar, its default for networkId 0.
  it('after_deadline passes with the calendar of its network and fails with the default preprod calendar', async () => {
    const script = plutusScript('v3_after_deadline');
    const slot = 80_000_000n;
    const preview = SLOT_CONFIGS.preview;
    const deadline = preview.zeroTime + (slot - preview.zeroSlot) * preview.slotLength;
    const opts = { datum: inlineDatum(deadline), validityStart: slot };
    expect((await judge(spendOf(script, { ...opts, network: 'preview' }).ctx)).rendered).toEqual([]);
    const preprod = await judge(spendOf(script, opts).ctx);
    expect(preprod.outcome).toMatchObject({ kind: 'failed', code: 'SCRIPT_FAILURE' });
    expect(preprod.rendered[0]).toMatch(FAILED);
    // One millisecond later than the slot start fails on preview too.
    expect((await judge(spendOf(script, { datum: inlineDatum(deadline + 1n), validityStart: slot, network: 'preview' }).ctx)).rendered[0]).toMatch(FAILED);
  });

  it('a V1 context with an inline datum is refused by collectFailures, given to scalus anyway it is CHW_EVALUATOR_FAILED with the scalus text', async () => {
    const { ctx, needs, locked } = spendOf(plutusScript('v1_always_succeeds'), { datum: inlineDatum(UNIT_DATA) });
    expect(collectFailures(ctx, needs).map(renderFailure)).toEqual([
      `ConwayUtxowFailure (UtxoFailure (UtxosFailure (CollectErrors (BadTranslation (BabbageContextError (InlineDatumsNotSupported (TxOutFromInput ${bytesToHex(locked.input.txId)}#0))) :| []))))`,
    ]);
    const error: unknown = await evaluateScripts(ctx, needs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChwError);
    expect(error).toMatchObject({ code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).message).toContain('Plutus V1 does not support inline datums');
  });

  it('the old two-argument V3 script returns a lambda, which CIP-117 fails', async () => {
    const { ctx } = spendOf(plutusScript('v3_two_args'));
    const { outcome, rendered } = await judge(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'INVALID_RETURN_VALUE' });
    expect(rendered[0]).toMatch(FAILED);
    expect(rendered[0]).toContain('INVALID_RETURN_VALUE: Spend[');
  });

  it('V1 and V2 spends with a datum hash and the datum in the witness set pass', async () => {
    for (const name of ['v1_always_succeeds', 'v2_always_succeeds'] as const) {
      const { ctx } = spendOf(plutusScript(name), { datum: UNIT_DATUM_HASH, witnessDatums: [UNIT_DATA] });
      const { outcome, rendered } = await judge(ctx);
      expect(outcome).toMatchObject({ kind: 'passed', runs: [{ mem: 1700n, steps: 256100n }] });
      expect(rendered).toEqual([]);
    }
  });

  it('an output scalus cannot read is CHW_EVALUATOR_FAILED, the TypeError of scalus as its cause', async () => {
    const { ctx, needs, locked } = spendOf(ALWAYS_SUCCEEDS);
    const broken = { ...ctx, resolved: ctx.resolved.map((u) => (u === locked ? { ...locked, scriptRef: Uint8Array.of(0xff) } : u)) };
    const error: unknown = await evaluateScripts(broken, needs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChwError);
    expect(error).toMatchObject({ code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

// eval_phase_two_raw of @lucid-evolution/uplc, uplc 1.1.22 compiled to WASM, a CommonJS package.
type LucidUplc = {
  eval_phase_two_raw(tx: Uint8Array, inputs: Uint8Array[], outputs: Uint8Array[], costModels: Uint8Array, maxSteps: bigint, maxMem: bigint, zeroTime: bigint, zeroSlot: bigint, slotLength: number): Uint8Array[];
};
const lucid = createRequire(import.meta.url)('@lucid-evolution/uplc') as LucidUplc;

/** ExUnits per redeemer from aiken's evaluator, sorted like scalus reports them. */
function aikenExUnits(ctx: CheckContext): Array<{ tag: bigint; index: bigint; mem: bigint; steps: bigint }> {
  const utxos = ctx.resolved.filter((u): u is Utxo => u !== undefined);
  const costModels = encode(new Map<CborValue, CborValue>([[0n, DEFAULT_COST_MODELS.PlutusV1], [1n, DEFAULT_COST_MODELS.PlutusV2], [2n, DEFAULT_COST_MODELS.PlutusV3]]));
  const slot = ctx.slotConfig;
  const params = DEFAULT_PROTOCOL_PARAMS[0];
  const results = lucid.eval_phase_two_raw(
    ctx.bytes,
    utxos.map((u) => encode([u.input.txId, u.input.index])),
    utxos.map((u) => encode(encodeOutput(u))),
    costModels,
    params.maxTxExSteps,
    params.maxTxExMem,
    slot.zeroTime,
    slot.zeroSlot,
    Number(slot.slotLength),
  );
  // redeemer = [tag, index, data, [mem, steps]]
  return results.map((bytes) => {
    const [tag, index, , [mem, steps]] = decode(bytes) as [bigint, bigint, CborValue, [bigint, bigint]];
    return { tag, index, mem, steps };
  });
}

describe('scalus against aiken', () => {
  const slot = 80_000_000n;
  const preprod = SLOT_CONFIGS.preprod;
  const passing: Array<[PlutusFixtureName, Parameters<typeof spendOf>[1]]> = [
    ['v3_always_succeeds', {}],
    ['v3_needs_signer', { datum: inlineDatum(SIGNER), requiredSigners: [SIGNER] }],
    ['v3_after_deadline', { datum: inlineDatum(preprod.zeroTime + (slot - preprod.zeroSlot) * preprod.slotLength), validityStart: slot }],
    ['v3_burn', { redeemer: 2_000n, exUnits: { mem: 5_000_000n, steps: 2_000_000_000n } }],
    ['v2_always_succeeds', { datum: UNIT_DATUM_HASH, witnessDatums: [UNIT_DATA] }],
    ['v1_always_succeeds', { datum: UNIT_DATUM_HASH, witnessDatums: [UNIT_DATA] }],
  ];

  it.each(passing)('%s: equal ExUnits', async (name, opts) => {
    const { ctx, needs } = spendOf(plutusScript(name), opts);
    const outcome = await evaluateScripts(ctx, needs);
    expect(outcome.kind).toBe('passed');
    expect(outcome.kind === 'passed' && outcome.runs).toEqual(aikenExUnits(ctx));
  });

  const failing = ['v3_always_fails', 'v3_always_fails_traced'] as const;

  it('covers every fixture', () => {
    expect([...passing.map(([name]) => name), ...failing, 'v3_two_args'].sort()).toEqual([...PLUTUS_FIXTURE_NAMES].sort());
  });

  it.each(failing)('%s: both refuse', async (name) => {
    const { ctx, needs } = spendOf(plutusScript(name));
    expect((await evaluateScripts(ctx, needs)).kind).toBe('failed');
    expect(() => aikenExUnits(ctx)).toThrow();
  });

  // CIP-117: a V3 script must return unit. aiken's evaluator does not check it, scalus does.
  it('v3_two_args: aiken accepts the lambda, scalus refuses it', async () => {
    const { ctx, needs } = spendOf(plutusScript('v3_two_args'));
    expect(await evaluateScripts(ctx, needs)).toMatchObject({ kind: 'failed', code: 'INVALID_RETURN_VALUE' });
    expect(aikenExUnits(ctx)).toHaveLength(1);
  });
});
