import { describe, expect, it } from 'vitest';
import { Address, Client, preprod } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { baseAddressBytes, cip129DRepId, enterpriseAddressBytes, isScriptPayment, networkTag, paymentHash, rewardAddressBytes, toBech32 } from '../src/core/addresses.js';
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

// CIP-105 test vectors 1 and 2, copied from
// https://github.com/cardano-foundation/CIPs/tree/master/CIP-0105/test-vectors
const CIP105 = [
  {
    accountIndex: 0,
    signingKeyHex: 'a8e57a8e0a68b7ab50c6cd13e8e0811718f506d34fca674e12740fdf73e1a45e612fa30b7e4bbe9883958dcf365de1e6c1607c33172c5d3d7754f3294e450925',
    verificationKeyHex: 'f74d7ac30513ac1825715fd0196769761fca6e7f69de33d04ef09a0c417a752b',
    keyHashHex: 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa',
    cip129: 'drep1y2jmg4g450lced7q9n34rq6d5vjwkm0ugx6h0894u6ur92s9txn3a',
  },
  {
    accountIndex: 256,
    signingKeyHex: '10fb8436bb02e2a4d3127860f771a9f1f9aff362f202346e3238b38a76e1a45eec82a22f492d48528c7e191f52b59489adf383db4811cbce4c6cdd8cef91c408',
    verificationKeyHex: '70344fe0329bbacbb33921e945daed181bd66889333eb73f3bb10ad8e4669976',
  },
];

describe('DRep key, CIP-105 role 3', () => {
  for (const v of CIP105) {
    it(`matches the CIP-105 vector for account ${v.accountIndex}`, () => {
      const { drep } = deriveAccount('test walk nut penalty hip pave soap entry language right filter choice', v.accountIndex);
      expect(drep.kind).toBe('extended');
      expect(bytesToHex(drep.bytes)).toBe(v.signingKeyHex);
      expect(bytesToHex(publicKey(drep))).toBe(v.verificationKeyHex);
      if (v.keyHashHex) expect(bytesToHex(keyHash(publicKey(drep)))).toBe(v.keyHashHex);
      if (v.cip129) expect(cip129DRepId(keyHash(publicKey(drep)))).toBe(v.cip129);
    });
  }

  it('matches CSL for the default mnemonic', () => {
    expect(bytesToHex(publicKey(deriveAccount(MNEMONIC).drep))).toBe(bytesToHex(cslDerive(MNEMONIC).drepPub));
  });

  it('builds the CIP-19 type 6 address a dApp constructs for the DRep key', () => {
    const hash = hexToBytes('a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa');
    expect(bytesToHex(enterpriseAddressBytes(0, hash))).toBe('60' + bytesToHex(hash));
    expect(bytesToHex(enterpriseAddressBytes(1, hash))).toBe('61' + bytesToHex(hash));
  });
});
