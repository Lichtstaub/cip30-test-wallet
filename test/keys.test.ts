import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bech32 } from '@scure/base';
import { bytesToHex } from '../src/core/bytes.js';
import { keyHash, publicKey, sign, type SigningKey } from '../src/core/keys.js';
import { cslDerive } from './helpers/csl.js';
import { EXPECTED_HELLO_SIG_PREFIX, EXPECTED_PAYMENT_PUB_PREFIX, MNEMONIC } from './fixtures/vectors.js';

const hello = new TextEncoder().encode('hello');

describe('extended (BIP32-Ed25519) keys', () => {
  const ref = cslDerive(MNEMONIC);
  const key: SigningKey = { kind: 'extended', bytes: ref.paymentExtended };

  it('derives the same public key as CSL and the documented vector', () => {
    const pub = bytesToHex(publicKey(key));
    expect(pub).toBe(bytesToHex(ref.paymentPub));
    expect(pub.startsWith(EXPECTED_PAYMENT_PUB_PREFIX)).toBe(true);
  });

  it('signs byte for byte like CSL', () => {
    const sig = sign(key, hello);
    expect(bytesToHex(sig)).toBe(bytesToHex(ref.signHello));
    expect(bytesToHex(sig).startsWith(EXPECTED_HELLO_SIG_PREFIX)).toBe(true);
  });

  it('produces signatures that standard Ed25519 verification accepts', () => {
    const msg = new TextEncoder().encode('cardano-headless-wallet');
    expect(ed25519.verify(sign(key, msg), msg, publicKey(key))).toBe(true);
    expect(bytesToHex(sign(key, msg))).toBe(bytesToHex(ref.signWith(msg)));
  });
});

describe('seed (plain Ed25519) keys', () => {
  const seed = new Uint8Array(32).fill(7);
  const key: SigningKey = { kind: 'seed', bytes: seed };

  it('matches noble directly', () => {
    expect(bytesToHex(publicKey(key))).toBe(bytesToHex(ed25519.getPublicKey(seed)));
    expect(bytesToHex(sign(key, hello))).toBe(bytesToHex(ed25519.sign(hello, seed)));
  });
});

describe('keyHash', () => {
  it('is Blake2b-224 of the public key and matches CSL', () => {
    const ref = cslDerive(MNEMONIC);
    const h = keyHash(ref.paymentPub);
    expect(h).toHaveLength(28);
    // The base address body is header(1) + payment hash(28) + stake hash(28).
    // Compare against the hash CSL put into the address it built.
    const addrBytes = bech32.fromWords(bech32.decode(ref.paymentAddress as `${string}1${string}`, false).words);
    expect(bytesToHex(addrBytes.slice(1, 29))).toBe(bytesToHex(h));
  });

  it('rejects wrong key sizes', () => {
    expect(() => publicKey({ kind: 'seed', bytes: new Uint8Array(31) })).toThrow(/32/);
    expect(() => publicKey({ kind: 'extended', bytes: new Uint8Array(63) })).toThrow(/64/);
  });
});
