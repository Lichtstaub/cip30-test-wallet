// Node side. The protocol parameters the ledger checks read, with defaults per
// network and an override that takes values the way Koios prints them.
import { MAX_INT64, MAX_UINT64, MIN_INT64 } from '../core/value.js';
import { DEFAULT_COST_MODELS, type CostModels } from './cost-models.js';

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
  /** One cost model per Plutus language, for the script integrity hash and the script evaluation. */
  costModels: CostModels;
  /** The major protocol version the scripts are evaluated under. */
  protocolMajorVersion: bigint;
}

export type IntegerInput = number | bigint | string;
export type RationalInput = number | string | [IntegerInput, IntegerInput];
type SingleParams = Omit<ProtocolParams, 'costModels'>;
export type ProtocolParamsInput = { [K in keyof SingleParams]?: SingleParams[K] extends Rational ? RationalInput : IntegerInput } & {
  /** The Koios form, per language an array of integers. A language left out keeps its default. */
  costModels?: Partial<Record<'PlutusV1' | 'PlutusV2' | 'PlutusV3', ReadonlyArray<IntegerInput>>>;
};

const rational = (numerator: bigint, denominator: bigint): Rational => Object.freeze({ numerator, denominator });

// Koios epoch_params on 2026-09-30: preprod epoch 316, mainnet epoch 658, both
// on protocol version 11.0. Koios prints the prices as 0.0577 and 7.21e-05,
// the exact fractions of the Alonzo genesis. Preview had the preprod value for
// every parameter here. The cost models are the same on all three networks,
// see cost-models.ts.
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
  costModels: DEFAULT_COST_MODELS,
  protocolMajorVersion: 11n,
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

/** A bigint, a safe integer number or a string of these digits as bigint, undefined for anything else. */
function coerceInteger(value: unknown, digits: RegExp): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && digits.test(value)) return BigInt(value);
  return undefined;
}

function parseInteger(value: unknown, what: string): bigint {
  const n = coerceInteger(value, /^\d+$/);
  if (n === undefined || n < 0n || n > MAX_UINT64) {
    throw new Error(`${what} must be a non-negative integer as number, bigint or decimal string, got ${show(value)}`);
  }
  return n;
}

const LANGUAGES = ['PlutusV1', 'PlutusV2', 'PlutusV3'] as const;

/** A cost model is a list of Int64 of any length (core Plutus/CostModels.hs CostModel). */
function parseCostModel(value: unknown, what: string): bigint[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${what} must be a non-empty array of integers, got ${show(value)}`);
  // Array.from visits holes too, a sparse array fails on its first hole.
  return Array.from(value as unknown[], (entry, i) => {
    const n = coerceInteger(entry, /^-?\d+$/);
    if (n === undefined || n < MIN_INT64 || n > MAX_INT64) {
      throw new Error(`${what}[${i}] must be an integer from -2^63 to 2^63 - 1 as number, bigint or decimal string, got ${show(entry)}`);
    }
    return n;
  });
}

/** Replaces the cost model of every language the override names, in models. */
function applyCostModels(value: unknown, models: CostModels): void {
  const what = 'ledger.protocolParams.costModels';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object of Plutus language to cost model, got ${show(value)}`);
  }
  for (const [language, model] of Object.entries(value)) {
    if (!(LANGUAGES as readonly string[]).includes(language)) throw new Error(`${what}.${language} is not a Plutus language, known: ${LANGUAGES.join(', ')}`);
    if (model === undefined) continue;
    models[language as keyof CostModels] = parseCostModel(model, `${what}.${language}`);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function lowestTerms(numerator: bigint, denominator: bigint): Rational {
  const d = gcd(numerator, denominator);
  return { numerator: numerator / d, denominator: denominator / d };
}

// No Rational parameter needs more than 20 digits, so a larger exponent is refused before 10 ** exponent is computed.
const MAX_DECIMAL_EXPONENT = 40n;

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
  const power = BigInt(exponent);
  // Checked before the power is computed, a text like 1e1000000000 would otherwise take forever.
  if (power > MAX_DECIMAL_EXPONENT || power < -MAX_DECIMAL_EXPONENT) {
    throw new Error(`${what} exponent must be between -${MAX_DECIMAL_EXPONENT} and ${MAX_DECIMAL_EXPONENT}, got ${power}`);
  }
  const shift = power - BigInt(fraction.length);
  const digits = BigInt(whole! + fraction);
  const result = shift >= 0n ? lowestTerms(digits * 10n ** shift, 1n) : lowestTerms(digits, 10n ** -shift);
  if (result.numerator > MAX_UINT64 || result.denominator > MAX_UINT64) {
    throw new Error(`${what} must have a numerator and denominator of at most 2^64 - 1 in lowest terms, got ${show(value)}`);
  }
  return result;
}

/**
 * The defaults of the network with single parameters replaced. Integers take
 * number, bigint or a decimal string, the Rational parameters also a decimal
 * or [numerator, denominator]. costModels replaces the cost model of each
 * language it names with a non-empty array of integers, negative ones
 * included. An unknown key or a bad value throws a plain Error that starts
 * with ledger.protocolParams.<key>.
 */
export function resolveProtocolParams(networkId: 0 | 1, override: ProtocolParamsInput | undefined): ProtocolParams {
  const defaults = DEFAULT_PROTOCOL_PARAMS[networkId];
  // A copy down to the arrays, a caller may change what it gets back.
  const { PlutusV1, PlutusV2, PlutusV3 } = defaults.costModels;
  const params: ProtocolParams = { ...defaults, costModels: { PlutusV1: [...PlutusV1], PlutusV2: [...PlutusV2], PlutusV3: [...PlutusV3] } };
  if (override === undefined) return params;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    throw new Error(`ledger.protocolParams must be an object of parameter overrides, got ${show(override)}`);
  }
  for (const [key, value] of Object.entries(override)) {
    const what = `ledger.protocolParams.${key}`;
    if (!Object.hasOwn(params, key)) throw new Error(`${what} is not a parameter the checks read, known: ${Object.keys(params).join(', ')}`);
    if (value === undefined) continue;
    if (key === 'costModels') {
      applyCostModels(value, params.costModels);
      continue;
    }
    const name = key as keyof SingleParams;
    (params as Record<keyof SingleParams, bigint | Rational>)[name] = typeof params[name] === 'bigint' ? parseInteger(value, what) : parseRational(value as RationalInput, what);
  }
  return params;
}
