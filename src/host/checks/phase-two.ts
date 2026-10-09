import { bytesToHex } from '../../core/bytes.js';
import { ChwError, type ChwErrorCode } from '../../core/errors.js';
import { encodeUtxo } from '../../core/ledger.js';
import { knownInputs, type CheckContext } from './context.js';
import { PATH, showText, type Failure } from './failure.js';
import type { PlutusNeed, RedeemerTag } from './plutus-purposes.js';

// Phase 2 of a Conway node: Conway/Rules/Utxos.hs utxosTransition, which runs
// Babbage/Rules/Utxos.hs expectScriptsToPass for is_valid true and
// babbageEvalScriptsTxInvalid for is_valid false. The scripts run in scalus,
// imported here and nowhere else, on the first submit that needs it.
//
// The node gives each script its declared ExUnits as the budget
// (Plutus/Evaluate.hs evaluatePlutusWithContext with pwcExUnits). scalus takes
// one budget for the whole transaction, so it runs with maxTxExUnits and the
// computed ExUnits are compared with the declared ones per redeemer afterwards.
// scalus stops at the first failing script, the node names every one.
// collectFailures has refused every script context the ledger cannot build
// before anything runs, scalus only sees contexts a node would evaluate.

export interface ScriptRun {
  tag: RedeemerTag;
  index: bigint;
  mem: bigint;
  steps: bigint;
}

export type EvaluationOutcome =
  | { kind: 'passed'; runs: ScriptRun[] }
  | {
      kind: 'failed';
      need: PlutusNeed | undefined;
      /** The hash scalus names for the failing script, hex, carried when no need matches its redeemer. */
      scriptHash?: string;
      code: string;
      logs: string[];
      message: string;
    };

type Scalus = typeof import('scalus');

// RedeemerBudget.tag of scalus to the redeemer tags of the Conway CDDL. A Map, so no prototype key reads as a tag.
const TAGS: ReadonlyMap<string, RedeemerTag> = new Map([
  ['Spend', 0n],
  ['Mint', 1n],
  ['Cert', 2n],
  ['Reward', 3n],
  ['Voting', 4n],
  ['Proposing', 5n],
]);

// The codes of a PlutusScriptEvaluationError that name a failing script. INTERNAL_ERROR is a defect in scalus.
const SCRIPT_FAILURES: ReadonlySet<string> = new Set(['SCRIPT_FAILURE', 'BUILTIN_FAILURE', 'INVALID_RETURN_VALUE', 'OUT_OF_BUDGET']);

/** '<what> (<the message of cause>). <advice>', with cause attached to the error. */
function chwError(code: ChwErrorCode, what: string, advice: string, cause: unknown): ChwError {
  const error = new ChwError(code, `${what} (${cause instanceof Error ? cause.message : String(cause)}). ${advice}`);
  error.cause = cause;
  return error;
}

/** Not cached here. Node keeps a loaded module and tries a failed resolve again on the next submit, a module that threw while loading stays failed. */
async function loadScalus(): Promise<Scalus> {
  try {
    return await import('scalus');
  } catch (cause) {
    throw chwError(
      'CHW_EVALUATOR_UNAVAILABLE',
      'the ledger checks could not load the Plutus evaluator scalus',
      'Reinstall cip30-test-wallet with its dependencies, or submit this transaction in a test without walletOptions.ledger.checks',
      cause,
    );
  }
}

/** scalus stopped other than with a failing script, a harness diagnosis that carries the scalus text and the error itself. */
function evaluatorFailed(cause: unknown): ChwError {
  return chwError('CHW_EVALUATOR_FAILED', 'the Plutus evaluator scalus could not evaluate this transaction', 'Submit this transaction in a test without walletOptions.ledger.checks', cause);
}

/** Whether an entry names the redeemer pointer (tag, index) of the given one. */
const samePointer =
  (pointer: { tag: bigint; index: bigint }) =>
  (entry: { tag: bigint; index: bigint }): boolean =>
    entry.tag === pointer.tag && entry.index === pointer.index;

function tagOf(name: string): RedeemerTag {
  const tag = TAGS.get(name);
  if (tag === undefined) throw new Error(`scalus reported an unknown redeemer tag ${name}`);
  return tag;
}

/**
 * The failed outcome when scalus stopped at a failing script, undefined for anything else. It may throw on an
 * error it cannot read, such as an unknown redeemer tag, the caller turns that into CHW_EVALUATOR_FAILED.
 */
function scriptFailure(scalus: Scalus, error: unknown, needs: readonly PlutusNeed[]): EvaluationOutcome | undefined {
  const ErrorClass: unknown = scalus.PlutusScriptEvaluationError;
  if (typeof ErrorClass !== 'function' || !(error instanceof scalus.PlutusScriptEvaluationError)) return undefined;
  if (error.code === undefined || !SCRIPT_FAILURES.has(error.code)) return undefined;
  const { redeemer } = error;
  let need: PlutusNeed | undefined;
  if (redeemer) {
    need = needs.find(samePointer({ tag: tagOf(redeemer.tag), index: BigInt(redeemer.index) }));
  }
  const scriptHash = need === undefined && typeof error.scriptHash === 'string' ? { scriptHash: error.scriptHash } : {};
  return { kind: 'failed', need, ...scriptHash, code: error.code, logs: [...error.logs], message: error.message };
}

/**
 * Lazily loads scalus, evaluates with maxTxExUnits as the budget. Throws ChwError CHW_EVALUATOR_UNAVAILABLE when scalus
 * cannot be loaded, ChwError CHW_EVALUATOR_FAILED when scalus stops other than with a script failure.
 * Without needs nothing runs and scalus is not loaded.
 */
export async function evaluateScripts(ctx: CheckContext, needs: readonly PlutusNeed[]): Promise<EvaluationOutcome> {
  if (needs.length === 0) return { kind: 'passed', runs: [] };
  const scalus = await loadScalus();
  // Spend inputs and reference inputs, the UTxOs the script context is built from. Collateral is never part of it.
  const utxos = knownInputs(ctx).flatMap(({ label, utxo }) => (label !== 'collateral input' && utxo ? [encodeUtxo(utxo)] : []));
  const { params, slotConfig } = ctx;
  try {
    const budgets = scalus.evaluator.evaluateTx(
      ctx.bytes,
      utxos,
      { zeroTime: slotConfig.zeroTime, zeroSlot: slotConfig.zeroSlot, slotLength: Number(slotConfig.slotLength) },
      params.costModels,
      Number(params.protocolMajorVersion),
      { memory: params.maxTxExMem, steps: params.maxTxExSteps },
    );
    return { kind: 'passed', runs: budgets.map((b) => ({ tag: tagOf(b.tag), index: BigInt(b.index), mem: BigInt(b.budget.memory), steps: BigInt(b.budget.steps) })) };
  } catch (error) {
    let failed: EvaluationOutcome | undefined;
    try {
      failed = scriptFailure(scalus, error, needs);
    } catch {
      failed = undefined;
    }
    if (failed) return failed;
    // Anything else is a harness diagnosis: INTERNAL_ERROR, an evaluation error without a code, a TypeError for
    // input scalus cannot read, a plain Error such as a script that does not decode, an error the wallet cannot
    // read. A node never reports these.
    throw evaluatorFailed(error);
  }
}

/**
 * The text of a PlutusFailure after the head of Plutus/Evaluate.hs explainPlutusEvaluationError: language, script hash and the
 * evaluation error, here the scalus code and the first line of its message. The node also prints the base64 script bytes, the
 * protocol version and the arguments, the wallet leaves those out. The node evaluates quietly and prints no traces, the wallet
 * adds the script's traces at the end.
 */
function failureText(need: PlutusNeed | undefined, scriptHash: string | undefined, error: string, logs: readonly string[]): string {
  const lines = [
    '',
    need ? `The PlutusV${need.language} script failed:` : 'The Plutus script failed:',
    ...(scriptHash ? [`The script hash is:ScriptHash "${scriptHash}"`] : []),
    `The plutus evaluation error is: ${error}`,
    ...(logs.length > 0 ? ['The script traces are:', ...logs] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Computed against declared ExUnits per redeemer, then the outcome against the is_valid flag. Empty when the transaction is consistent.
 * Throws ChwError CHW_EVALUATOR_FAILED when scalus passed without ExUnits for a needed script.
 */
export function phaseTwoFailures(ctx: CheckContext, needs: readonly PlutusNeed[], outcome: EvaluationOutcome): Failure[] {
  let failure: string | undefined;
  if (outcome.kind === 'failed') {
    const firstLine = outcome.message.split('\n')[0]!;
    failure = failureText(outcome.need, outcome.need ? bytesToHex(outcome.need.scriptHash) : outcome.scriptHash, `${outcome.code}: ${firstLine}`, outcome.logs);
  } else {
    // The declared ExUnits are each script's budget. A script that needs more fails, in the node with
    // the CEK machine's out of budget error, here with the units both sides name.
    for (const need of needs) {
      const run = outcome.runs.find(samePointer(need));
      if (!run) throw evaluatorFailed(new Error(`scalus reported no ExUnits for ${need.purpose}, a script the transaction needs`));
      // MissingRedeemers has refused a need without a redeemer before anything runs.
      const declared = ctx.facts.redeemers.find(samePointer(need));
      if (!declared || (run.mem <= declared.mem && run.steps <= declared.steps)) continue;
      const error = `OUT_OF_BUDGET: ${need.purpose} needs ExUnits {mem: ${run.mem}, steps: ${run.steps}}, its redeemer declares ExUnits {mem: ${declared.mem}, steps: ${declared.steps}}`;
      failure = failureText(need, bytesToHex(need.scriptHash), error, []);
      break;
    }
  }

  // Babbage/Rules/Utxos.hs: with is_valid true a failing script is FailedUnexpectedly, with is_valid false
  // every script passing is PassedUnexpectedly, also when there is no script. Alonzo/Rules/Utxos.hs
  // scriptFailureToFailureDescription puts the base64 of the script and its arguments in the second
  // field of PlutusFailure, which stays empty here.
  const tagMismatch = (detail: string): Failure[] => [{ path: PATH.UTXOS, rule: 'ValidationTagMismatch', detail }];
  if (ctx.parsed.isValid) return failure === undefined ? [] : tagMismatch(`(IsValid True) (FailedUnexpectedly (PlutusFailure ${showText(failure)} "" :| []))`);
  return failure === undefined ? tagMismatch('(IsValid False) PassedUnexpectedly') : [];
}
