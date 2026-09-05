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
});
