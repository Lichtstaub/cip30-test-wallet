// A scalus that cannot be loaded or that stops without a script failure, in its
// own file: vi.doMock and vi.resetModules replace the module graph, and
// phase-two.ts is imported afresh after each.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseAddressBytes } from '../src/core/addresses.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import type { Utxo } from '../src/core/ledger.js';
import { deriveAccount } from '../src/derive/index.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { checkContext } from './helpers/check-context.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { lockedUtxo, plutusSpend } from './helpers/plutus-spend.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const myAddress = baseAddressBytes(0, keyHash(publicKey(me.payment)), keyHash(publicKey(me.stake)));
const wallet: Utxo = { input: syntheticInput('unavailable-wallet', 0n), address: myAddress, lovelace: 50_000_000n };
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

describe('an evaluator that stops without a script failure', () => {
  it.each([
    ['INTERNAL_ERROR, a defect in scalus', 'INTERNAL_ERROR'],
    ['no code', undefined],
  ])('a PlutusScriptEvaluationError with %s is ChwError CHW_EVALUATOR_FAILED with its text and the error as cause', async (_name, code) => {
    // The class the module exports, phase-two.ts checks instanceof against it.
    class PlutusScriptEvaluationError extends Error {
      readonly logs: string[] = [];
      readonly code: string | undefined;
      constructor(message: string, errorCode: string | undefined) {
        super(message);
        this.code = errorCode;
      }
    }
    const thrown = new PlutusScriptEvaluationError('the machine broke', code);
    vi.resetModules();
    vi.doMock('scalus', () => ({
      PlutusScriptEvaluationError,
      evaluator: {
        evaluateTx: () => {
          throw thrown;
        },
      },
    }));
    const { evaluateScripts } = await import('../src/host/checks/phase-two.js');
    const error: unknown = await evaluateScripts(ctx, needs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'ChwError', code: 'CHW_EVALUATOR_FAILED' });
    expect((error as Error).message).toContain('(the machine broke)');
    expect((error as Error).cause).toBe(thrown);
  });
});
