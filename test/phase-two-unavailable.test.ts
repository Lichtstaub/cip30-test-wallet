// A scalus that cannot be loaded, that stops without a script failure or whose
// failure names no needed redeemer, in its own file: vi.doMock and vi.resetModules replace the module graph, and
// phase-two.ts is imported afresh after each.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { checkContext } from './helpers/check-context.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { lockedUtxo, myWallet, plutusSpend } from './helpers/plutus-spend.js';

const { myAddress, wallet } = myWallet('unavailable-wallet');
const script = plutusScript('v3_always_succeeds');
const locked = lockedUtxo(script, 'unavailable-locked');
const ctx = checkContext(plutusSpend({ spends: [{ utxo: locked, script }], wallet, changeAddress: myAddress }), [wallet, locked]);
const needs = plutusNeeds(ctx);

afterEach(() => {
  vi.doUnmock('scalus');
  vi.resetModules();
});

describe('an evaluator that cannot be loaded', () => {
  it('is ChwError CHW_EVALUATOR_UNAVAILABLE with the cause, and the next evaluation loads it again', async () => {
    const cause = new Error("Cannot find package 'scalus'");
    vi.resetModules();
    vi.doMock('scalus', () => {
      throw cause;
    });
    const { evaluateScripts } = await import('../src/host/checks/phase-two.js');
    const { ChwError } = await import('../src/core/errors.js');
    const error: unknown = await evaluateScripts(ctx, needs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChwError);
    expect(error).toMatchObject({ code: 'CHW_EVALUATOR_UNAVAILABLE' });
    expect((error as Error).message).toContain('could not load the Plutus evaluator scalus');
    // vitest may wrap what the factory throws, the original is somewhere down the cause chain.
    const causes: unknown[] = [];
    for (let c: unknown = (error as Error).cause; c !== undefined && causes.length < 5; c = (c as Error).cause) causes.push(c);
    expect(causes).toContain(cause);

    vi.doUnmock('scalus');
    expect(await evaluateScripts(ctx, needs)).toMatchObject({ kind: 'passed' });
  });

  it('without needs nothing is loaded, so a missing scalus does not matter', async () => {
    vi.resetModules();
    vi.doMock('scalus', () => {
      throw new Error('must not be loaded');
    });
    const { evaluateScripts } = await import('../src/host/checks/phase-two.js');
    expect(await evaluateScripts(ctx, [])).toEqual({ kind: 'passed', runs: [] });
  });
});

// The class the module exports, phase-two.ts checks instanceof against it.
class PlutusScriptEvaluationError extends Error {
  readonly logs: string[] = [];
  readonly code: string | undefined;
  readonly redeemer: { tag: string; index: number } | undefined;
  readonly scriptHash: string | undefined;
  constructor(message: string, errorCode: string | undefined, extra: { redeemer?: { tag: string; index: number }; scriptHash?: string } = {}) {
    super(message);
    this.code = errorCode;
    this.redeemer = extra.redeemer;
    this.scriptHash = extra.scriptHash;
  }
}

/** phase-two.ts imported afresh against a scalus whose evaluateTx is this function, with or without the error class. */
async function withScalus(evaluateTx: () => unknown, errorClass = true) {
  vi.resetModules();
  // A missing export reads as undefined from a module namespace. The mock names it, vitest would throw for an absent key.
  vi.doMock('scalus', () => ({ PlutusScriptEvaluationError: errorClass ? PlutusScriptEvaluationError : undefined, evaluator: { evaluateTx } }));
  return import('../src/host/checks/phase-two.js');
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('an evaluator that stops without a script failure', () => {
  it.each([
    ['INTERNAL_ERROR, a defect in scalus', 'INTERNAL_ERROR'],
    ['no code', undefined],
  ])('a PlutusScriptEvaluationError with %s is ChwError CHW_EVALUATOR_FAILED with its text and the error as cause', async (_name, code) => {
    const thrown = new PlutusScriptEvaluationError('the machine broke', code);
    const { evaluateScripts } = await withScalus(() => {
      throw thrown;
    });
    const error = await rejection(evaluateScripts(ctx, needs));
    expect(error).toMatchObject({ name: 'ChwError', code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).message).toContain('(the machine broke)');
    expect((error as Error).cause).toBe(thrown);
  });

  // scalus declares six redeemer tags. Another name, or one only an object prototype knows, means a scalus the wallet cannot read.
  it.each(['Withdraw', 'constructor'])('a script failure under the unknown redeemer tag %s is ChwError CHW_EVALUATOR_FAILED', async (tag) => {
    const thrown = new PlutusScriptEvaluationError('Withdraw[0] failed', 'SCRIPT_FAILURE', { redeemer: { tag, index: 0 } });
    const { evaluateScripts } = await withScalus(() => {
      throw thrown;
    });
    const error = await rejection(evaluateScripts(ctx, needs));
    expect(error).toMatchObject({ name: 'ChwError', code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).cause).toBe(thrown);
  });

  it('a scalus without the PlutusScriptEvaluationError export is ChwError CHW_EVALUATOR_FAILED with what it threw', async () => {
    const thrown = new Error('Spend[0] failed');
    const { evaluateScripts } = await withScalus(() => {
      throw thrown;
    }, false);
    const error = await rejection(evaluateScripts(ctx, needs));
    expect(error).toMatchObject({ name: 'ChwError', code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).cause).toBe(thrown);
  });

  it('a run scalus does not report for a needed script is ChwError CHW_EVALUATOR_FAILED naming the purpose', async () => {
    const { evaluateScripts, phaseTwoFailures } = await withScalus(() => []);
    const outcome = await evaluateScripts(ctx, needs);
    expect(outcome).toEqual({ kind: 'passed', runs: [] });
    let error: unknown;
    try {
      phaseTwoFailures(ctx, needs, outcome);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: 'ChwError', code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).message).toContain(needs[0]!.purpose);
  });
});

describe('a script failure scalus does not tie to a needed redeemer', () => {
  const hash = 'ab'.repeat(28);

  it.each([
    ['without a redeemer', undefined],
    ['with a redeemer no need has', { tag: 'Spend', index: 7 }],
  ])('%s fails with the script hash scalus names', async (_name, redeemer) => {
    const thrown = new PlutusScriptEvaluationError('Spend[7] failed: Error evaluated', 'SCRIPT_FAILURE', { ...(redeemer ? { redeemer } : {}), scriptHash: hash });
    const { evaluateScripts, phaseTwoFailures } = await withScalus(() => {
      throw thrown;
    });
    const outcome = await evaluateScripts(ctx, needs);
    expect(outcome).toMatchObject({ kind: 'failed', need: undefined, scriptHash: hash, code: 'SCRIPT_FAILURE' });
    const [failure] = phaseTwoFailures(ctx, needs, outcome);
    expect(failure!.rule).toBe('ValidationTagMismatch');
    expect(failure!.detail).toContain(`The Plutus script failed:\\nThe script hash is:ScriptHash \\"${hash}\\"\\nThe plutus evaluation error is: SCRIPT_FAILURE: Spend[7] failed`);
  });
});
