import { describe, expect, it } from 'vitest';
import { jsonInteger, parseJsonBig } from '../src/host/chain/json.js';

describe('parseJsonBig', () => {
  it('keeps integers above 2^53 exact as decimal strings', () => {
    expect(parseJsonBig('{"q":18446744073709551615,"p":9007199254740993,"n":-9223372036854775808}')).toEqual({
      q: '18446744073709551615',
      p: '9007199254740993',
      n: '-9223372036854775808',
    });
  });

  it('leaves integers of up to 15 digits as numbers, 16 digits become strings even below 2^53', () => {
    expect(parseJsonBig('[999999999999999,-999999999999999,1000000000000000,0,-1]')).toEqual([999999999999999, -999999999999999, '1000000000000000', 0, -1]);
  });

  it('reads cost model padding of int64 max in a list without touching its neighbours', () => {
    expect(parseJsonBig('{"plutus:v2":[100788,420,9223372036854775807,9223372036854775807]}')).toEqual({ 'plutus:v2': [100788, 420, '9223372036854775807', '9223372036854775807'] });
  });

  it('leaves fractions and exponents as numbers, however many digits they have', () => {
    expect(parseJsonBig('{"m":1.2,"e":1e21,"f":12345678901234567.5,"g":2.5E-7,"h":10000000000000000e2}')).toEqual({ m: 1.2, e: 1e21, f: 12345678901234567.5, g: 2.5e-7, h: 1e18 });
  });

  it('never looks into strings, escaped quotes included', () => {
    expect(parseJsonBig('{"s":"x\\"12345678901234567890","t":"\\\\","k":12345678901234567890}')).toEqual({ s: 'x"12345678901234567890', t: '\\', k: '12345678901234567890' });
  });

  it('keeps keys, booleans and null as JSON.parse reads them', () => {
    expect(parseJsonBig('{"12345678901234567890":true,"b":false,"c":null}')).toEqual({ '12345678901234567890': true, b: false, c: null });
  });

  it.each([
    ['a missing value', '{"a":}'],
    ['a long integer with a leading zero', '{"a":01234567890123456}'],
    ['text that is no JSON', 'Bad Gateway'],
    ['an empty body', ''],
  ])('throws like JSON.parse on %s', (_name, text) => {
    expect(() => parseJsonBig(text)).toThrow(SyntaxError);
  });
});

describe('jsonInteger', () => {
  it('reads safe numbers and decimal strings as bigint', () => {
    expect(jsonInteger(42, 'x')).toBe(42n);
    expect(jsonInteger(-1, 'x')).toBe(-1n);
    expect(jsonInteger('18446744073709551615', 'x')).toBe(18446744073709551615n);
    expect(jsonInteger('-9223372036854775808', 'x')).toBe(-9223372036854775808n);
  });

  it.each([
    ['a fraction', 1.5],
    ['an unsafe number', 2 ** 53 + 2],
    ['a hex string', '0x10'],
    ['a string with spaces', ' 1'],
    ['null', null],
    ['a missing value', undefined],
  ])('refuses %s and names the field', (_name, value) => {
    expect(() => jsonInteger(value, 'value.ada.lovelace')).toThrow(/^value\.ada\.lovelace must be an integer/);
  });
});
