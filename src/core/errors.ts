// CIP-30 errors are plain objects, not Error instances. That is what real
// wallets throw and what dApp code must cope with. Mock specific problems
// (a test forgot to configure a UTxO) are real Errors on purpose, so they
// can never be mistaken for wallet behaviour.

export const APIErrorCode = {
  InvalidRequest: -1,
  InternalError: -2,
  Refused: -3,
  AccountChange: -4,
} as const;

export const TxSignErrorCode = {
  ProofGeneration: 1,
  UserDeclined: 2,
  // CIP-95: returned regardless of user consent for certificate 5 or 6.
  DeprecatedCertificate: 3,
} as const;

export const TxSendErrorCode = {
  Refused: 1,
  Failure: 2,
} as const;

export const DataSignErrorCode = {
  ProofGeneration: 1,
  AddressNotPK: 2,
  UserDeclined: 3,
} as const;

export interface Cip30Error {
  code: number;
  info: string;
}

export function apiError(code: (typeof APIErrorCode)[keyof typeof APIErrorCode], info: string): Cip30Error {
  return { code, info };
}

export function txSignError(code: (typeof TxSignErrorCode)[keyof typeof TxSignErrorCode], info: string): Cip30Error {
  return { code, info };
}

export function txSendError(code: (typeof TxSendErrorCode)[keyof typeof TxSendErrorCode], info: string): Cip30Error {
  return { code, info };
}

export function dataSignError(code: (typeof DataSignErrorCode)[keyof typeof DataSignErrorCode], info: string): Cip30Error {
  return { code, info };
}

/** A plain CIP-30 error object: numeric code, string info, not an Error instance. */
export function isCip30Error(value: unknown): value is Cip30Error {
  if (typeof value !== 'object' || value === null || value instanceof Error) return false;
  const { code, info } = value as { code?: unknown; info?: unknown };
  return typeof code === 'number' && typeof info === 'string';
}

/**
 * CHW_UNRESOLVED_INPUT: an input, collateral input or reference input the ledger does not know, or in chain mode one the chain does not show unspent.
 * CHW_UNRESOLVED_SCRIPT: a script the transaction needs that is neither in the witness set nor a reference script of an input or reference input.
 * CHW_UNSUPPORTED_TX_FORM: a transaction form this release cannot reason about, from signTx at partialSign false or from submitTx under the ledger checks.
 * CHW_EVALUATOR_UNAVAILABLE: the ledger checks need the Plutus evaluator and could not load it.
 * CHW_EVALUATOR_FAILED: the Plutus evaluator stopped on a transaction other than with a script failure.
 * CHW_CHAIN_UNAVAILABLE: the chain provider gave no usable answer (no connection, timeout, an HTTP error, a body that is not the expected JSON, a JSON-RPC error of its own).
 * CHW_MAINNET_LOCKED: signTx on a wallet whose chain is mainnet, without walletOptions.ledger.chain.allowMainnetSigning.
 */
export type ChwErrorCode =
  | 'CHW_UNRESOLVED_INPUT'
  | 'CHW_UNRESOLVED_SCRIPT'
  | 'CHW_UNSUPPORTED_TX_FORM'
  | 'CHW_EVALUATOR_UNAVAILABLE'
  | 'CHW_EVALUATOR_FAILED'
  | 'CHW_CHAIN_UNAVAILABLE'
  | 'CHW_MAINNET_LOCKED';

export class ChwError extends Error {
  constructor(
    public readonly code: ChwErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ChwError';
  }
}
