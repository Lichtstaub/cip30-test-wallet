import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { baseAddressBytes, enterpriseAddressBytes, rewardAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { keyHash } from '../src/core/hash.js';
import { publicKey } from '../src/core/keys.js';
import { parseAddressArg, parseHexArg, resolveDataSigner } from '../src/core/sign-data.js';
import { deriveAccount } from '../src/derive/index.js';
import { MNEMONIC } from './fixtures/vectors.js';

const a = deriveAccount(MNEMONIC);
const keys = { networkId: 0 as const, payment: a.payment, stake: a.stake, drep: a.drep };
const pay = keyHash(publicKey(a.payment));
const stk = keyHash(publicKey(a.stake));
const drp = keyHash(publicKey(a.drep));
const other = new Uint8Array(28).fill(9);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: unknown }).code;
  }
  return 'no error';
};

describe('parseAddressArg', () => {
  it('reads lower and upper case hex and bech32 to the same bytes', () => {
    const base = baseAddressBytes(0, pay, stk);
    const words = bech32.toWords(base);
    expect(bytesToHex(parseAddressArg(bytesToHex(base)))).toBe(bytesToHex(base));
    expect(bytesToHex(parseAddressArg(bytesToHex(base).toUpperCase()))).toBe(bytesToHex(base));
    expect(bytesToHex(parseAddressArg(bech32.encode('addr_test', words, false)))).toBe(bytesToHex(base));
  });

  it('rejects non strings, empty and odd length input as InvalidRequest', () => {
    for (const bad of [undefined, 42, '', 'abc', 'zz', 'addr_test1notbech32']) expect(code(() => parseAddressArg(bad))).toBe(-1);
  });
});

describe('parseHexArg', () => {
  it('accepts the empty payload and rejects odd or non hex payloads', () => {
    expect(parseHexArg('', 'payload')).toHaveLength(0);
    expect(code(() => parseHexArg('abc', 'payload'))).toBe(-1);
    expect(code(() => parseHexArg('zz', 'payload'))).toBe(-1);
    expect(code(() => parseHexArg(7, 'payload'))).toBe(-1);
  });
});

describe('resolveDataSigner, CIP-30', () => {
  it('signs base and own type 6 addresses with the payment key, reward addresses with the stake key', () => {
    expect(resolveDataSigner(baseAddressBytes(0, pay, stk), keys, 'cip30').role).toBe('payment');
    expect(resolveDataSigner(enterpriseAddressBytes(0, pay), keys, 'cip30').role).toBe('payment');
    expect(resolveDataSigner(rewardAddressBytes(0, stk), keys, 'cip30').role).toBe('stake');
  });

  it('puts the given address bytes into the header', () => {
    const reward = rewardAddressBytes(0, stk);
    expect(bytesToHex(resolveDataSigner(reward, keys, 'cip30').headerAddress)).toBe(bytesToHex(reward));
  });

  it('answers ProofGeneration for foreign hashes, another network and Byron', () => {
    expect(code(() => resolveDataSigner(baseAddressBytes(0, other, stk), keys, 'cip30'))).toBe(1);
    expect(code(() => resolveDataSigner(rewardAddressBytes(0, other), keys, 'cip30'))).toBe(1);
    expect(code(() => resolveDataSigner(baseAddressBytes(1, pay, stk), keys, 'cip30'))).toBe(1);
    expect(code(() => resolveDataSigner(hexToBytes('82' + '00'.repeat(40)), keys, 'cip30'))).toBe(1);
  });

  it('answers AddressNotPK for script credentials', () => {
    expect(code(() => resolveDataSigner(hexToBytes('10' + '00'.repeat(56)), keys, 'cip30'))).toBe(2);
    expect(code(() => resolveDataSigner(hexToBytes('70' + '00'.repeat(28)), keys, 'cip30'))).toBe(2);
    expect(code(() => resolveDataSigner(hexToBytes('f0' + '00'.repeat(28)), keys, 'cip30'))).toBe(2);
  });

  it('answers InvalidRequest for a bare hash, a wrong length for the type and a CIP-129 id', () => {
    expect(code(() => resolveDataSigner(drp, keys, 'cip30'))).toBe(-1);
    expect(code(() => resolveDataSigner(hexToBytes('00' + '00'.repeat(28)), keys, 'cip30'))).toBe(-1);
    expect(code(() => resolveDataSigner(hexToBytes('22' + bytesToHex(drp)), keys, 'cip30'))).toBe(-1);
  });

  it('parses pointer addresses completely', () => {
    const own = bytesToHex(pay);
    expect(resolveDataSigner(hexToBytes('40' + own + '010203'), keys, 'cip30').role).toBe('payment');
    expect(resolveDataSigner(hexToBytes('40' + own + '81010203'), keys, 'cip30').role).toBe('payment');
    expect(code(() => resolveDataSigner(hexToBytes('40' + own), keys, 'cip30'))).toBe(-1);
    expect(code(() => resolveDataSigner(hexToBytes('40' + own + '010281'), keys, 'cip30'))).toBe(-1);
    expect(code(() => resolveDataSigner(hexToBytes('40' + own + '01020304'), keys, 'cip30'))).toBe(-1);
  });

  it('never signs with the DRep key in the CIP-30 path', () => {
    expect(code(() => resolveDataSigner(enterpriseAddressBytes(0, drp), keys, 'cip30'))).toBe(1);
  });
});
