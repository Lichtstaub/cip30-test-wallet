// Node side. The protocol parameters the ledger checks read, with defaults per
// network and an override that takes values the way Koios prints them.
import { MAX_UINT64 } from '../core/value.js';

/** An exact fraction in lowest terms, the way the ledger keeps its Rational parameters. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export interface ProtocolParams {
  minFeeA: bigint;
  minFeeB: bigint;
  maxTxSize: bigint;
  maxValSize: bigint;
  keyDeposit: bigint;
  poolDeposit: bigint;
  drepDeposit: bigint;
  govActionDeposit: bigint;
  coinsPerUtxoByte: bigint;
  priceMem: Rational;
  priceSteps: Rational;
  maxTxExMem: bigint;
  maxTxExSteps: bigint;
  collateralPercent: bigint;
  maxCollateralInputs: bigint;
  minFeeRefScriptCostPerByte: Rational;
}

export type IntegerInput = number | bigint | string;
export type RationalInput = number | string | [IntegerInput, IntegerInput];
export type ProtocolParamsInput = { [K in keyof ProtocolParams]?: ProtocolParams[K] extends Rational ? RationalInput : IntegerInput };

const rational = (numerator: bigint, denominator: bigint): Rational => Object.freeze({ numerator, denominator });

// Koios epoch_params on 2026-09-30: preprod epoch 316, mainnet epoch 658, both
// on protocol version 11.0. Koios prints the prices as 0.0577 and 7.21e-05,
// the exact fractions of the Alonzo genesis. Preview had the preprod value for
// every parameter here.
const PREPROD: ProtocolParams = Object.freeze({
  minFeeA: 44n,
  minFeeB: 155_381n,
  maxTxSize: 16_384n,
  maxValSize: 5_000n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  govActionDeposit: 1_000_000_000n,
  coinsPerUtxoByte: 4_310n,
  priceMem: rational(577n, 10_000n),
  priceSteps: rational(721n, 10_000_000n),
  maxTxExMem: 17_500_000n,
  maxTxExSteps: 10_000_000_000n,
  collateralPercent: 150n,
  maxCollateralInputs: 3n,
  minFeeRefScriptCostPerByte: rational(15n, 1n),
});

const MAINNET: ProtocolParams = Object.freeze({
  ...PREPROD,
  govActionDeposit: 100_000_000_000n,
  maxTxExMem: 16_500_000n,
});

/** networkId 0: preprod (the checked values equal preview), 1: mainnet. Koios epoch_params, 2026-09-30. */
export const DEFAULT_PROTOCOL_PARAMS: Readonly<Record<0 | 1, ProtocolParams>> = Object.freeze({ 0: PREPROD, 1: MAINNET });

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  return String(value);
}

function parseInteger(value: unknown, what: string): bigint {
  let n: bigint | undefined;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  if (n === undefined || n < 0n || n > MAX_UINT64) {
    throw new Error(`${what} must be a non-negative integer as number, bigint or decimal string, got ${show(value)}`);
  }
  return n;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function lowestTerms(numerator: bigint, denominator: bigint): Rational {
  const d = gcd(numerator, denominator);
  return { numerator: numerator / d, denominator: denominator / d };
}

// A decimal with an optional exponent, what String(number) prints for 0.0577 or 1e-7.
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A non-negative fraction, exact and in lowest terms. [numerator, denominator]
 * as integers, or a decimal number or string read by its digits, so 0.0577 is
 * exactly 577/10000. A number is read through String(value), the shortest text
 * that gives the same number back. Throws a plain Error naming what.
 */
export function parseRational(value: RationalInput, what: string): Rational {
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new Error(`${what} must be [numerator, denominator], got ${show(value)}`);
    const numerator = parseInteger(value[0], `${what} numerator`);
    const denominator = parseInteger(value[1], `${what} denominator`);
    if (denominator === 0n) throw new Error(`${what} denominator must be positive, got ${show(value)}`);
    return lowestTerms(numerator, denominator);
  }
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const match = typeof text === 'string' ? DECIMAL.exec(text) : null;
  if (!match) throw new Error(`${what} must be a non-negative decimal as number or string, or [numerator, denominator], got ${show(value)}`);
  const [, whole, fraction = '', exponent = '0'] = match;
  const shift = BigInt(exponent) - BigInt(fraction.length);
  const digits = BigInt(whole! + fraction);
  return shift >= 0n ? lowestTerms(digits * 10n ** shift, 1n) : lowestTerms(digits, 10n ** -shift);
}

/**
 * The defaults of the network with single parameters replaced. Integers take
 * number, bigint or a decimal string, the Rational parameters also a decimal
 * or [numerator, denominator]. An unknown key or a bad value throws a plain
 * Error that starts with ledger.protocolParams.<key>.
 */
export function resolveProtocolParams(networkId: 0 | 1, override: ProtocolParamsInput | undefined): ProtocolParams {
  const params: ProtocolParams = { ...DEFAULT_PROTOCOL_PARAMS[networkId] };
  if (override === undefined) return params;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    throw new Error(`ledger.protocolParams must be an object of parameter overrides, got ${show(override)}`);
  }
  for (const [key, value] of Object.entries(override)) {
    const what = `ledger.protocolParams.${key}`;
    if (!Object.hasOwn(params, key)) throw new Error(`${what} is not a parameter the checks read, known: ${Object.keys(params).join(', ')}`);
    if (value === undefined) continue;
    const name = key as keyof ProtocolParams;
    (params as Record<keyof ProtocolParams, bigint | Rational>)[name] = typeof params[name] === 'bigint' ? parseInteger(value, what) : parseRational(value as RationalInput, what);
  }
  return params;
}
