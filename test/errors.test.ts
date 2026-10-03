import { describe, expect, it } from 'vitest';
import { APIErrorCode, apiError, ChwError, isCip30Error, TxSendErrorCode, txSendError } from '../src/core/errors.js';

describe('TxSendError', () => {
  it('has the CIP-30 codes Refused 1 and Failure 2', () => {
    expect(TxSendErrorCode).toEqual({ Refused: 1, Failure: 2 });
  });

  it('is a plain object with code and info', () => {
    const e = txSendError(TxSendErrorCode.Failure, 'ConwayApplyTxError []');
    expect(e).toEqual({ code: 2, info: 'ConwayApplyTxError []' });
    expect(e).not.toBeInstanceOf(Error);
  });
});

describe('isCip30Error', () => {
  it('accepts plain objects with a numeric code and a string info', () => {
    expect(isCip30Error(txSendError(TxSendErrorCode.Refused, 'x'))).toBe(true);
    expect(isCip30Error(apiError(APIErrorCode.InvalidRequest, 'x'))).toBe(true);
    // What arrives through JSON, and an object with more fields.
    expect(isCip30Error(JSON.parse('{"code":2,"info":""}'))).toBe(true);
    expect(isCip30Error({ code: -1, info: 'x', extra: true })).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'error'],
    ['a code as string', { code: '2', info: 'x' }],
    ['no info', { code: 2 }],
    ['info that is no string', { code: 2, info: 3 }],
    ['an Error with code and info', Object.assign(new Error('x'), { code: 2, info: 'x' })],
    ['a ChwError', new ChwError('CHW_UNSUPPORTED_TX_FORM', 'x')],
  ])('refuses %s', (_name, value) => {
    expect(isCip30Error(value)).toBe(false);
  });
});
