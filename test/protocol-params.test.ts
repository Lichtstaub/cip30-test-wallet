import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTOCOL_PARAMS, parseRational, resolveProtocolParams, type ProtocolParamsInput } from '../src/host/protocol-params.js';

const r = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });

/** Koios epoch_params field names to the override form, values exactly as Koios prints them. */
function fromKoios(k: Record<string, unknown>): ProtocolParamsInput {
  return {
    minFeeA: k['min_fee_a'] as number,
    minFeeB: k['min_fee_b'] as number,
    maxTxSize: k['max_tx_size'] as number,
    maxValSize: k['max_val_size'] as number,
    keyDeposit: k['key_deposit'] as string,
    poolDeposit: k['pool_deposit'] as string,
    drepDeposit: k['drep_deposit'] as string,
    govActionDeposit: k['gov_action_deposit'] as string,
    coinsPerUtxoByte: k['coins_per_utxo_size'] as string,
    priceMem: k['price_mem'] as number,
    priceSteps: k['price_step'] as number,
    maxTxExMem: k['max_tx_ex_mem'] as number,
    maxTxExSteps: k['max_tx_ex_steps'] as number,
    collateralPercent: k['collateral_percent'] as number,
    maxCollateralInputs: k['max_collateral_inputs'] as number,
    minFeeRefScriptCostPerByte: k['min_fee_ref_script_cost_per_byte'] as number,
  };
}

describe('default protocol parameters', () => {
  it('preprod equals the Koios epoch_params fixture read as an override', () => {
    const [koios] = JSON.parse(readFileSync('test/fixtures/koios-epoch-params-preprod.json', 'utf8')) as Record<string, unknown>[];
    const input = fromKoios(koios!);
    // Every parameter comes from the fixture, none from the defaults.
    expect(Object.keys(input).sort()).toEqual(Object.keys(DEFAULT_PROTOCOL_PARAMS[0]).sort());
    expect(resolveProtocolParams(0, input)).toEqual(DEFAULT_PROTOCOL_PARAMS[0]);
  });

  it('carries the exact prices and the reference script cost', () => {
    expect(DEFAULT_PROTOCOL_PARAMS[0].priceMem).toEqual(r(577n, 10_000n));
    expect(DEFAULT_PROTOCOL_PARAMS[0].priceSteps).toEqual(r(721n, 10_000_000n));
    expect(DEFAULT_PROTOCOL_PARAMS[0].minFeeRefScriptCostPerByte).toEqual(r(15n, 1n));
  });

  it('mainnet differs from preprod in the governance action deposit and the memory limit only', () => {
    expect(DEFAULT_PROTOCOL_PARAMS[1]).toEqual({ ...DEFAULT_PROTOCOL_PARAMS[0], govActionDeposit: 100_000_000_000n, maxTxExMem: 16_500_000n });
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(DEFAULT_PROTOCOL_PARAMS[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROTOCOL_PARAMS[0].priceMem)).toBe(true);
    const resolved = resolveProtocolParams(0, undefined);
    resolved.minFeeA = 1n;
    expect(DEFAULT_PROTOCOL_PARAMS[0].minFeeA).toBe(44n);
  });
});

describe('parseRational', () => {
  it.each([
    [0.0577, r(577n, 10_000n)],
    [7.21e-5, r(721n, 10_000_000n)],
    ['0.0577', r(577n, 10_000n)],
    ['7.21e-05', r(721n, 10_000_000n)],
    [1e-7, r(1n, 10_000_000n)],
    [15, r(15n, 1n)],
    ['15', r(15n, 1n)],
    ['1.5E2', r(150n, 1n)],
    ['0.50', r(1n, 2n)],
    [0, r(0n, 1n)],
    [[577, 10_000], r(577n, 10_000n)],
    [[2n, '4'], r(1n, 2n)],
    [[0, 7], r(0n, 1n)],
    // Both sit on the edge of the cap, the exponent 40 itself is allowed as long as the reduced fraction fits.
    ['10000000000000000000000000000000000000000e-40', r(1n, 1n)],
    ['0e40', r(0n, 1n)],
    ['18446744073709551615', r(18446744073709551615n, 1n)],
    ['0.0000000000000000001', r(1n, 10_000_000_000_000_000_000n)],
  ] as const)('reads %s exactly', (value, expected) => {
    expect(parseRational(value as never, 'x')).toEqual(expected);
  });

  it.each([
    ['a negative number', -0.5, 'price must be a non-negative decimal as number or string, or [numerator, denominator], got -0.5'],
    ['a negative decimal string', '-1', 'price must be a non-negative decimal as number or string, or [numerator, denominator], got "-1"'],
    ['text', 'abc', 'price must be a non-negative decimal as number or string, or [numerator, denominator], got "abc"'],
    ['a fraction string', '1/2', 'price must be a non-negative decimal as number or string, or [numerator, denominator], got "1/2"'],
    ['NaN', Number.NaN, 'price must be a non-negative decimal as number or string, or [numerator, denominator], got NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'price must be a non-negative decimal as number or string, or [numerator, denominator], got Infinity'],
    ['a boolean', true, 'price must be a non-negative decimal as number or string, or [numerator, denominator], got true'],
    ['a pair of three', [1, 2, 3], 'price must be [numerator, denominator], got [1, 2, 3]'],
    ['a zero denominator', [1, 0], 'price denominator must be positive, got [1, 0]'],
    ['a negative numerator', [-1, 2], 'price numerator must be a non-negative integer as number, bigint or decimal string, got -1'],
    ['a huge exponent, refused before the power is computed', '1e1000000000', 'price exponent must be between -40 and 40, got 1000000000'],
    ['a huge negative exponent', '1e-1000000000', 'price exponent must be between -40 and 40, got -1000000000'],
    ['1e300', 1e300, 'price exponent must be between -40 and 40, got 300'],
    ['a numerator above 2^64 - 1', '1e20', 'price must have a numerator and denominator of at most 2^64 - 1 in lowest terms, got "1e20"'],
    ['a denominator above 2^64 - 1', '5e-40', 'price must have a numerator and denominator of at most 2^64 - 1 in lowest terms, got "5e-40"'],
    ['a fractional numerator', [0.5, 2], 'price numerator must be a non-negative integer as number, bigint or decimal string, got 0.5'],
  ])('refuses %s with a message naming the parameter', (_name, value, message) => {
    expect(() => parseRational(value as never, 'price')).toThrow(message);
  });
});

describe('resolveProtocolParams', () => {
  it('picks the defaults by network, 0 for preprod and 1 for mainnet', () => {
    expect(resolveProtocolParams(0, undefined)).toEqual(DEFAULT_PROTOCOL_PARAMS[0]);
    expect(resolveProtocolParams(1, undefined)).toEqual(DEFAULT_PROTOCOL_PARAMS[1]);
    expect(resolveProtocolParams(1, {}).govActionDeposit).toBe(100_000_000_000n);
  });

  it('replaces single parameters and keeps the rest', () => {
    const params = resolveProtocolParams(1, { minFeeA: 50, keyDeposit: '3000000', maxTxExSteps: 20_000_000_000n, priceMem: [1, 10] });
    expect(params).toEqual({ ...DEFAULT_PROTOCOL_PARAMS[1], minFeeA: 50n, keyDeposit: 3_000_000n, maxTxExSteps: 20_000_000_000n, priceMem: r(1n, 10n) });
  });

  it('skips a key set to undefined', () => {
    expect(resolveProtocolParams(0, { minFeeA: undefined } as unknown as ProtocolParamsInput)).toEqual(DEFAULT_PROTOCOL_PARAMS[0]);
  });

  it.each([
    ['an unknown key', { minFee: 44 }, 'ledger.protocolParams.minFee is not a parameter the checks read, known: minFeeA, minFeeB'],
    ['an inherited key', JSON.parse('{"toString": 1}'), 'ledger.protocolParams.toString is not a parameter the checks read'],
    ['a negative integer', { keyDeposit: -1 }, 'ledger.protocolParams.keyDeposit must be a non-negative integer as number, bigint or decimal string, got -1'],
    ['a fractional integer', { minFeeA: 44.5 }, 'ledger.protocolParams.minFeeA must be a non-negative integer as number, bigint or decimal string, got 44.5'],
    ['an unsafe number', { maxTxExSteps: 2 ** 53 }, 'ledger.protocolParams.maxTxExSteps must be a non-negative integer as number, bigint or decimal string, got 9007199254740992'],
    ['a decimal string for an integer', { minFeeB: '1.5' }, 'ledger.protocolParams.minFeeB must be a non-negative integer as number, bigint or decimal string, got "1.5"'],
    ['an integer above 2^64 - 1', { maxTxSize: 2n ** 64n }, 'ledger.protocolParams.maxTxSize must be a non-negative integer as number, bigint or decimal string, got 18446744073709551616n'],
    ['a pair for an integer', { minFeeA: [1, 2] }, 'ledger.protocolParams.minFeeA must be a non-negative integer as number, bigint or decimal string, got [1, 2]'],
    ['a bad price', { priceSteps: 'cheap' }, 'ledger.protocolParams.priceSteps must be a non-negative decimal as number or string, or [numerator, denominator], got "cheap"'],
  ])('refuses %s', (_name, override, message) => {
    expect(() => resolveProtocolParams(0, override as ProtocolParamsInput)).toThrow(message);
  });

  it.each([
    ['an array', [44]],
    ['null', null],
    ['a number', 44],
  ])('refuses %s as override', (_name, override) => {
    expect(() => resolveProtocolParams(0, override as never)).toThrow(/^ledger\.protocolParams must be an object of parameter overrides/);
  });
});
