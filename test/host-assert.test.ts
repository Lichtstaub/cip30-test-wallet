import { describe, expect, it } from 'vitest';
import { Transaction } from '@evolution-sdk/evolution';
import { rewardAddressBytes, toBech32 } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { signCose } from '../src/core/cose.js';
import { keyHash } from '../src/core/hash.js';
import { publicKey } from '../src/core/keys.js';
import { deriveAccount } from '../src/derive/index.js';
import { expectSignedBy, expectSignedData } from '../src/host/assert.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { MNEMONIC } from './fixtures/vectors.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';

describe('expectSignedBy', () => {
  it('passes for a transaction the wallet signed and fails for the unsigned one', async () => {
    const prepared = prepareWallet();
    const target: InstallTarget = {};
    installWallet(prepared.config, target);
    const api = await enableChw(target);
    const unsigned = standardUnsignedTx('chw');
    const signed = Transaction.addVKeyWitnessesHex(unsigned, await api.signTx(unsigned, false));
    expect(() => expectSignedBy(signed, prepared)).not.toThrow();
    expect(() => expectSignedBy(unsigned, prepared)).toThrow(/no valid witness/);
  });

  it('fails when the witness belongs to another wallet', async () => {
    const mine = prepareWallet();
    const other = prepareWallet({ accountIndex: 1 });
    const target: InstallTarget = {};
    installWallet(other.config, target);
    const api = await enableChw(target);
    const unsigned = standardUnsignedTx('chw');
    const signed = Transaction.addVKeyWitnessesHex(unsigned, await api.signTx(unsigned, true));
    expect(() => expectSignedBy(signed, mine)).toThrow(/no valid witness/);
  });
});

describe('expectSignedData', () => {
  const account = deriveAccount(MNEMONIC);
  const reward = rewardAddressBytes(0, keyHash(publicKey(account.stake)));
  const payload = bytesToHex(new TextEncoder().encode('login nonce'));
  const good = () => {
    const s = signCose(account.stake, reward, hexToBytes(payload));
    return { signature: bytesToHex(s.signature), key: bytesToHex(s.key) };
  };

  it('accepts a correct signature and returns the header address and key', () => {
    const r = expectSignedData(good(), { payload, address: bytesToHex(reward), publicKeyHex: bytesToHex(publicKey(account.stake)) });
    expect(bytesToHex(r.address)).toBe(bytesToHex(reward));
  });

  it('accepts the expected address in bech32', () => {
    expect(() => expectSignedData(good(), { payload, address: toBech32(reward) })).not.toThrow();
  });

  it('rejects another payload, another address, another key and a key that does not match the address', () => {
    expect(() => expectSignedData(good(), { payload: '00' })).toThrow(/payload/);
    expect(() => expectSignedData(good(), { payload, address: 'e0' + '00'.repeat(28) })).toThrow(/address/);
    expect(() => expectSignedData(good(), { payload, publicKeyHex: '00'.repeat(32) })).toThrow(/public key/);
    const wrongBinding = signCose(account.payment, reward, hexToBytes(payload));
    expect(() => expectSignedData({ signature: bytesToHex(wrongBinding.signature), key: bytesToHex(wrongBinding.key) }, { payload, address: bytesToHex(reward) })).toThrow(/does not match the address/);
  });

  it('rejects a bare key hash header unless the test names it or allows it', () => {
    // A payment key signing with its own bare hash as header: the binding
    // holds, but a CIP-30 verifier needs the address, so this must not pass.
    const bareHash = keyHash(publicKey(account.payment));
    const bare = signCose(account.payment, bareHash, hexToBytes(payload));
    const result = { signature: bytesToHex(bare.signature), key: bytesToHex(bare.key) };
    expect(() => expectSignedData(result, { payload })).toThrow(/bare 28 byte key hash/);
    expect(() => expectSignedData(result, { payload, publicKeyHex: bytesToHex(publicKey(account.payment)) })).toThrow(/bare 28 byte key hash/);
    expect(() => expectSignedData(result, { payload, allowBareKeyHash: true })).not.toThrow();
    expect(() => expectSignedData(result, { payload, address: bytesToHex(bareHash) })).not.toThrow();
    expect(() => expectSignedData(result, { payload, address: bytesToHex(reward) })).toThrow(/differs from the expected address/);
  });

  it('checks the key against the header address even when the test names no address', () => {
    const wrongBinding = signCose(account.payment, reward, hexToBytes(payload));
    expect(() => expectSignedData({ signature: bytesToHex(wrongBinding.signature), key: bytesToHex(wrongBinding.key) }, { payload })).toThrow(/does not match the address/);
  });

  it('rejects a tampered signature', () => {
    const r = good();
    const tampered = r.signature.slice(0, -2) + (r.signature.endsWith('00') ? '01' : '00');
    expect(() => expectSignedData({ ...r, signature: tampered }, { payload })).toThrow(/signature/);
  });

  it('rejects a malformed expected address', () => {
    expect(() => expectSignedData(good(), { payload, address: 'zz' })).toThrow(/expectSignedData:/);
  });

  it('rejects a malformed key', () => {
    const { signature } = good();
    expect(() => expectSignedData({ signature, key: 'zz' }, { payload })).toThrow(/expectSignedData:/);
  });
});
