import { describe, expect, it } from 'vitest';
import { Address, Client, preprod } from '@evolution-sdk/evolution';
import { bytesToHex } from '../src/core/bytes.js';
import { baseAddressBytes, isScriptPayment, networkTag, paymentHash, rewardAddressBytes, toBech32 } from '../src/core/addresses.js';
import { keyHash, publicKey, sign } from '../src/core/keys.js';
import { deriveAccount } from '../src/derive/index.js';
import { cslDerive } from './helpers/csl.js';
import { EXPECTED_PAYMENT_ADDRESS, EXPECTED_REWARD_ADDRESS, MNEMONIC, NETWORK_ID } from './fixtures/vectors.js';

describe('exit criterion 3: wallet restore', () => {
  const account = deriveAccount(MNEMONIC);
  const payHash = keyHash(publicKey(account.payment));
  const stakeHash = keyHash(publicKey(account.stake));
  const base = baseAddressBytes(NETWORK_ID as 0, payHash, stakeHash);
  const reward = rewardAddressBytes(NETWORK_ID as 0, stakeHash);

  it('matches the documented CSL vector', () => {
    expect(toBech32(base)).toBe(EXPECTED_PAYMENT_ADDRESS);
    expect(toBech32(reward)).toBe(EXPECTED_REWARD_ADDRESS);
  });

  it('matches CSL as an independent implementation', () => {
    const ref = cslDerive(MNEMONIC);
    expect(toBech32(base)).toBe(ref.paymentAddress);
    expect(toBech32(reward)).toBe(ref.rewardAddress);
    expect(bytesToHex(account.payment.bytes)).toBe(bytesToHex(ref.paymentExtended));
  });

  it('matches what Evolution derives for the same seed', async () => {
    const client = Client.make(preprod).withSeed({ mnemonic: MNEMONIC });
    expect(Address.toBech32(await client.address())).toBe(EXPECTED_PAYMENT_ADDRESS);
    const rewardAddr = await client.rewardAddress();
    expect(typeof rewardAddr === 'string' ? rewardAddr : Address.toBech32(rewardAddr as never)).toBe(EXPECTED_REWARD_ADDRESS);
  });

  it('signs byte for byte like Evolution with the same extended key', async () => {
    const { Bip32PrivateKey, Ed25519Signature, PrivateKey } = await import('@evolution-sdk/evolution');
    const { mnemonicToEntropy } = await import('@scure/bip39');
    const { wordlist } = await import('@scure/bip39/wordlists/english.js');
    const root = Bip32PrivateKey.fromBip39Entropy(mnemonicToEntropy(MNEMONIC, wordlist));
    const evoKey = Bip32PrivateKey.toPrivateKey(Bip32PrivateKey.derivePath(root, "m/1852'/1815'/0'/0/0"));
    const msg = new TextEncoder().encode('cardano-headless-wallet');
    const evoSig = Ed25519Signature.toBytes(PrivateKey.sign(evoKey, msg));
    expect(bytesToHex(sign(account.payment, msg))).toBe(bytesToHex(evoSig));
  });
});

describe('address helpers', () => {
  const account = deriveAccount(MNEMONIC);
  const payHash = keyHash(publicKey(account.payment));
  const stakeHash = keyHash(publicKey(account.stake));

  it('encodes the network tag in the header nibble and the prefix', () => {
    const testnet = baseAddressBytes(0, payHash, stakeHash);
    const mainnet = baseAddressBytes(1, payHash, stakeHash);
    expect(networkTag(testnet)).toBe(0);
    expect(networkTag(mainnet)).toBe(1);
    expect(toBech32(mainnet).startsWith('addr1')).toBe(true);
    expect(toBech32(rewardAddressBytes(1, stakeHash)).startsWith('stake1')).toBe(true);
  });

  it('exposes the payment credential and detects script payments', () => {
    const base = baseAddressBytes(0, payHash, stakeHash);
    expect(bytesToHex(paymentHash(base))).toBe(bytesToHex(payHash));
    expect(isScriptPayment(base)).toBe(false);
    const scriptBase = new Uint8Array(base);
    scriptBase[0] = 0x10; // header type 1: script payment, key stake
    expect(isScriptPayment(scriptBase)).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(() => baseAddressBytes(0, new Uint8Array(27), stakeHash)).toThrow(/28/);
    expect(() => networkTag(new Uint8Array(0))).toThrow();
  });
});
