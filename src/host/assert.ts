import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesEqual, bytesToHex, hexToBytes } from '../core/bytes.js';
import { parseTransaction } from '../core/cbor/tx.js';
import { decodeCoseKey, decodeCoseSign1, sigStructure } from '../core/cose.js';
import { keyHash } from '../core/hash.js';
import { keyCredentialOf, parseAddressArg } from '../core/sign-data.js';
import type { Role } from '../core/requirements.js';

/** The wallet keys a test can require a witness from. The same union signTx uses for its roles. */
export type SignerRole = Role;

/**
 * Proves the submitted transaction really carries this wallet's signature
 * over its own body hash, for every role the test names (payment when it
 * names none). Recording submitTx alone proves nothing, a dApp could submit
 * the unsigned transaction and still get a hash back.
 */
export function expectSignedBy(
  txHex: string,
  wallet: { paymentPublicKeyHex: string; stakePublicKeyHex?: string; drepPublicKeyHex?: string },
  options: { roles?: SignerRole[] } = {},
): void {
  const roles = options.roles ?? ['payment'];
  // An empty list would pass without checking anything.
  if (roles.length === 0) throw new Error('expectSignedBy: roles must name at least one key');
  const { hash, vkeyWitnesses } = parseTransaction(hexToBytes(txHex));
  const keys: Record<SignerRole, string | undefined> = {
    payment: wallet.paymentPublicKeyHex,
    stake: wallet.stakePublicKeyHex,
    drep: wallet.drepPublicKeyHex,
  };
  for (const role of roles) {
    const hex = keys[role];
    if (!hex) throw new Error(`expectSignedBy: the wallet handle has no ${role} public key`);
    const pub = hexToBytes(hex);
    const ok = vkeyWitnesses.some((w) => bytesEqual(w.vkey, pub) && ed25519.verify(w.signature, hash, pub));
    if (!ok) throw new Error(`expectSignedBy: no valid witness from the wallet's ${role} key over body hash ${bytesToHex(hash)}`);
  }
}

export interface SignedDataExpectation {
  /** Hex of the payload the dApp asked the wallet to sign. */
  payload: string;
  /** Hex or bech32. When set, the COSE "address" header must hold exactly these bytes and the key must match its credential. */
  address?: string;
  publicKeyHex?: string;
  /**
   * Accept a bare 28 byte key hash as the address header without naming it in
   * `address`. Only CIP-95 DRep signatures may carry that form, so it is off
   * unless the test asks for it.
   */
  allowBareKeyHash?: boolean;
}

/**
 * Proves a signData result the way a careful verifier does: COSE_Key and
 * COSE_Sign1 shape, alg EdDSA, unhashed payload equal to the request, an
 * Ed25519 signature over the Sig_structure, and the key bound to the
 * address in the protected header, always. A bare 28 byte header is taken
 * as the key hash itself, as CIP-95 DRep signatures may carry it, but only
 * when the test names that hash in `address` or sets `allowBareKeyHash`.
 */
export function expectSignedData(result: { signature: string; key: string }, expected: SignedDataExpectation): { address: Uint8Array; publicKey: Uint8Array } {
  function fail(why: string): never {
    throw new Error(`expectSignedData: ${why}`);
  }
  // decodeCoseKey, decodeCoseSign1, parseAddressArg and keyCredentialOf
  // already throw for malformed input, one a real Error and the others a
  // plain CIP-30 error object. Neither should escape unprefixed, a failing
  // test must name this helper and never see a bare CIP-30 error shape. With
  // a fixed message, that message replaces the underlying error instead.
  const attempt = <T>(run: () => T, message?: string): T => {
    try {
      return run();
    } catch (err) {
      return fail(message ?? (err instanceof Error ? err.message : String(err)));
    }
  };
  const key = attempt(() => decodeCoseKey(hexToBytes(result.key)));
  if (key.kty !== 1n || key.alg !== -8n || key.crv !== 6n) fail('COSE_Key is not an OKP Ed25519 EdDSA key');
  const sign1 = attempt(() => decodeCoseSign1(hexToBytes(result.signature)));
  if (sign1.alg !== -8n) fail('protected header alg is not EdDSA');
  if (sign1.address === undefined) fail('protected header has no address');
  if (sign1.hashed) fail('payload is hashed, CIP-30 signData signs it unhashed');
  if (bytesToHex(sign1.payload) !== expected.payload.toLowerCase()) fail('payload differs from the request');
  if (!ed25519.verify(sign1.signature, sigStructure(sign1.protectedBytes, sign1.payload), key.x)) fail('signature does not verify over the Sig_structure');
  if (expected.publicKeyHex !== undefined && bytesToHex(key.x) !== expected.publicKeyHex.toLowerCase()) fail('public key differs from the expected key');
  const address = sign1.address!;
  const wantedAddress = expected.address;
  if (wantedAddress !== undefined) {
    const expectedAddress = attempt(() => parseAddressArg(wantedAddress), `expected address ${wantedAddress} is not a valid hex or bech32 address`);
    if (!bytesEqual(address, expectedAddress)) fail(`address header ${bytesToHex(address)} differs from the expected address`);
  }
  if (address.length === 28 && wantedAddress === undefined && expected.allowBareKeyHash !== true) {
    fail('address header is a bare 28 byte key hash, which only CIP-95 DRep signatures carry. Name it in address or set allowBareKeyHash');
  }
  // The key must control the header address, whether or not the test names one.
  const credential = attempt(() => keyCredentialOf(address), `address header ${bytesToHex(address)} is not a valid address`);
  if (credential === undefined) fail(`address header ${bytesToHex(address)} has no key credential`);
  if (!bytesEqual(keyHash(key.x), credential)) fail('public key does not match the address credential');
  return { address, publicKey: key.x };
}
