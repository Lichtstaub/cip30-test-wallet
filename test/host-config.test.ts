import { describe, expect, it } from 'vitest';
import { prepareWallet } from '../src/host/config.js';
import { EXPECTED_PAYMENT_ADDRESS, EXPECTED_PAYMENT_PUB_PREFIX, EXPECTED_REWARD_ADDRESS } from './fixtures/vectors.js';

describe('prepareWallet', () => {
  it('uses the public test mnemonic on preprod by default', () => {
    const w = prepareWallet();
    expect(w.config.name).toBe('chw');
    expect(w.config.networkId).toBe(0);
    expect(w.addresses.payment).toBe(EXPECTED_PAYMENT_ADDRESS);
    expect(w.addresses.reward).toBe(EXPECTED_REWARD_ADDRESS);
    expect(w.paymentPublicKeyHex.startsWith(EXPECTED_PAYMENT_PUB_PREFIX)).toBe(true);
    expect(w.config.utxos).toEqual([{ lovelace: '10000000' }]);
    expect(w.config.keys.payment.kind).toBe('extended');
  });

  it('is plain JSON with lovelace as decimal strings', () => {
    const w = prepareWallet({ utxos: [{ lovelace: 5_000_000n }, { lovelace: '7' }, { lovelace: 3 }] });
    expect(w.config.utxos).toEqual([{ lovelace: '5000000' }, { lovelace: '7' }, { lovelace: '3' }]);
    expect(JSON.parse(JSON.stringify(w.config))).toEqual(w.config);
  });

  it('builds mainnet addresses for networkId 1', () => {
    const w = prepareWallet({ networkId: 1 });
    expect(w.addresses.payment.startsWith('addr1')).toBe(true);
  });

  it('rejects an invalid mnemonic before anything reaches the page', () => {
    expect(() => prepareWallet({ mnemonic: 'not a mnemonic' })).toThrow(/mnemonic/);
  });

  it('rejects a negative lovelace amount', () => {
    expect(() => prepareWallet({ utxos: [{ lovelace: -1 }] })).toThrow(/non-negative/);
  });

  it('rejects a lovelace amount that is not an integer', () => {
    expect(() => prepareWallet({ utxos: [{ lovelace: 'abc' }] })).toThrow();
  });

  it('rejects a networkId outside 0 or 1', () => {
    expect(() => prepareWallet({ networkId: 2 as never })).toThrow(/networkId/);
  });

  it('rejects a malformed foreign utxo in Node, before it reaches the page', () => {
    const good = { txId: 'ab'.repeat(32), index: 0, addressHex: '60' + '11'.repeat(28), lovelace: 1 };
    expect(prepareWallet({ foreignUtxos: [good] }).config.foreignUtxos).toHaveLength(1);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, txId: 'zz' }] })).toThrow(/foreignUtxos\[0\]\.txId/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, txId: 'ab'.repeat(31) }] })).toThrow(/txId/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, index: -1 }] })).toThrow(/index/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, index: 0.5 }] })).toThrow(/index/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, addressHex: 'xyz' }] })).toThrow(/addressHex/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, addressHex: '' }] })).toThrow(/addressHex/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, addressHex: '00' }] })).toThrow(/addressHex/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, index: 1e100 }] })).toThrow(/index/);
    expect(() => prepareWallet({ foreignUtxos: [{ ...good, lovelace: true as never }] })).toThrow(/lovelace/);
  });

  it('rejects a negative accountIndex', () => {
    expect(() => prepareWallet({ accountIndex: -1 })).toThrow(/accountIndex/);
  });

  it('returns equal configs for two calls with the same options', () => {
    const a = prepareWallet({ accountIndex: 1 });
    const b = prepareWallet({ accountIndex: 1 });
    expect(a.config).toEqual(b.config);
  });

  it('exposes the DRep key, its hash and the CIP-129 id', () => {
    const w = prepareWallet();
    expect(w.config.keys.drep.kind).toBe('extended');
    expect(w.drepPublicKeyHex).toBe('f74d7ac30513ac1825715fd0196769761fca6e7f69de33d04ef09a0c417a752b');
    expect(w.drepKeyHashHex).toBe('a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa');
    expect(w.drepId).toBe('drep1y2jmg4g450lced7q9n34rq6d5vjwkm0ugx6h0894u6ur92s9txn3a');
    expect(w.config.stakeRegistered).toBe(false);
    expect(prepareWallet({ stakeRegistered: true }).config.stakeRegistered).toBe(true);
  });
});
