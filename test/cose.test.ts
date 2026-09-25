import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decodeCoseKey, decodeCoseSign1, sigStructure, signCose } from '../src/core/cose.js';
import { deriveAccount } from '../src/derive/index.js';
import { MNEMONIC } from './fixtures/vectors.js';
import { oracleSign, oracleSignedData } from './helpers/cose-oracle.js';

const account = deriveAccount(MNEMONIC);
const reward = hexToBytes('e0' + '11'.repeat(28));
const base = hexToBytes('00' + '22'.repeat(56));
const type6 = hexToBytes('60' + '33'.repeat(28));
const bare = hexToBytes('44'.repeat(28));
const payload = new TextEncoder().encode('dreptalk:example:nonce:1');

describe('signCose', () => {
  for (const [name, address] of [['reward', reward], ['base', base], ['type 6', type6], ['bare hash', bare]] as const) {
    it(`matches the reference library byte for byte with a ${name} address`, () => {
      const ours = signCose(account.stake, address, payload);
      const theirs = oracleSign(account.stake.bytes, address, payload);
      expect(bytesToHex(ours.signature)).toBe(bytesToHex(theirs.signature));
      expect(bytesToHex(ours.key)).toBe(bytesToHex(theirs.key));
    });
  }

  it('matches the reference library for an empty and a 64 KB payload', () => {
    for (const p of [new Uint8Array(0), new Uint8Array(65536).fill(7)]) {
      expect(bytesToHex(signCose(account.payment, base, p).signature)).toBe(bytesToHex(oracleSign(account.payment.bytes, base, p).signature));
    }
  });

  it('has the layout real signData responses start with', () => {
    const { signature, key } = signCose(account.stake, hexToBytes('e0' + '11'.repeat(28)), payload);
    expect(bytesToHex(signature).startsWith('84582aa201276761646472657373581de0')).toBe(true);
    expect(bytesToHex(key).startsWith('a4010103272006215820')).toBe(true);
  });

  it('signs exactly the Sig_structure the reference library reconstructs', () => {
    const { signature } = signCose(account.payment, base, payload);
    const decoded = decodeCoseSign1(signature);
    expect(bytesToHex(sigStructure(decoded.protectedBytes, decoded.payload))).toBe(bytesToHex(oracleSignedData(signature)));
  });
});

describe('decodeCoseSign1 and decodeCoseKey', () => {
  it('read back what signCose wrote', () => {
    const { signature, key } = signCose(account.stake, reward, payload);
    const s = decodeCoseSign1(signature);
    expect(s.alg).toBe(-8n);
    expect(bytesToHex(s.address!)).toBe(bytesToHex(reward));
    expect(s.hashed).toBe(false);
    expect(bytesToHex(s.payload)).toBe(bytesToHex(payload));
    expect(s.signature).toHaveLength(64);
    const k = decodeCoseKey(key);
    expect([k.kty, k.alg, k.crv]).toEqual([1n, -8n, 6n]);
    expect(k.x).toHaveLength(32);
  });

  it('accepts a COSE_Sign1 wrapped in tag 18', () => {
    const { signature } = signCose(account.stake, reward, payload);
    const tagged = new Uint8Array([0xd2, ...signature]);
    expect(decodeCoseSign1(tagged).alg).toBe(-8n);
  });

  it('rejects an unprotected header that is not a map or a hashed flag that is not a boolean', () => {
    // The unprotected header is not signed, so these mutations keep the signature valid.
    const hex = bytesToHex(signCose(account.stake, reward, payload).signature);
    expect(hex).toContain('a166686173686564f4');
    expect(() => decodeCoseSign1(hexToBytes(hex.replace('a166686173686564f4', 'f6')))).toThrow(/unprotected/);
    expect(() => decodeCoseSign1(hexToBytes(hex.replace('a166686173686564f4', 'a16668617368656400')))).toThrow(/hashed/);
    expect(() => decodeCoseSign1(hexToBytes(hex.replace('a166686173686564f4', 'a166686173686564f7')))).toThrow(/hashed/);
  });

  it('rejects a structure that is not a four element array, a detached payload and a key without x', () => {
    expect(() => decodeCoseSign1(hexToBytes('83404040'))).toThrow(/four element array/);
    expect(() => decodeCoseSign1(hexToBytes('8440a0f640'))).toThrow(/payload/);
    expect(() => decodeCoseKey(hexToBytes('a3010103272006'))).toThrow(/x/);
  });
});
