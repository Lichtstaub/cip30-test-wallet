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

export function dataSignError(code: (typeof DataSignErrorCode)[keyof typeof DataSignErrorCode], info: string): Cip30Error {
  return { code, info };
}

export type ChwErrorCode = 'CHW_UNRESOLVED_INPUT' | 'CHW_UNSUPPORTED_TX_FORM';

export class ChwError extends Error {
  constructor(
    public readonly code: ChwErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ChwError';
  }
}
