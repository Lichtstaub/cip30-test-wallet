// Resolves the addr argument of signData to the key that signs and to the
// bytes that go into the COSE "address" header. CIP-30: the payment key for
// address types 0, 2, 4 and 6, the stake key for type 14. CIP-95 adds the
// DRep key, addressed either by the bare 28 byte DRep ID or by a type 6
// address built from the DRep key hash. CIP-95 names no rule to tell these
// apart, length does it here: 28 bytes is a DRep ID, anything longer is an
// address.
import { bech32 } from '@scure/base';
import { isByronAddress, networkTag, paymentHash } from './addresses.js';
import { bytesEqual, hexToBytes } from './bytes.js';
import { APIErrorCode, apiError, DataSignErrorCode, dataSignError } from './errors.js';
import type { SigningKey } from './keys.js';

export type SignerRole = 'payment' | 'stake' | 'drep';

export interface DataSignerKeys {
  networkId: 0 | 1;
  payment: SigningKey;
  stake: SigningKey;
  drep: SigningKey;
  paymentPub: Uint8Array;
  stakePub: Uint8Array;
  drepPub: Uint8Array;
  paymentHash: Uint8Array;
  stakeHash: Uint8Array;
  drepHash: Uint8Array;
}

export interface ResolvedSigner {
  role: SignerRole;
  key: SigningKey;
  publicKey: Uint8Array;
  headerAddress: Uint8Array;
  /** Only for the DRep key: which of the two CIP-95 forms the caller used. */
  drepForm?: 'bare' | 'type6';
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export function parseHexArg(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || !HEX.test(value)) throw apiError(APIErrorCode.InvalidRequest, `${what} must be a hex string`);
  return hexToBytes(value.toLowerCase());
}

export function parseAddressArg(addr: unknown): Uint8Array {
  if (typeof addr !== 'string' || addr.length === 0) throw apiError(APIErrorCode.InvalidRequest, 'addr must be a hex or bech32 address');
  if (HEX.test(addr)) return hexToBytes(addr.toLowerCase());
  try {
    return bech32.fromWords(bech32.decode(addr as `${string}1${string}`, false).words);
  } catch {
    throw apiError(APIErrorCode.InvalidRequest, 'addr must be a hex or bech32 address');
  }
}

/** Expected byte length per Shelley header type, pointer addresses (4, 5) are checked by parsing. */
const LENGTH: Record<number, number> = { 0: 57, 1: 57, 2: 57, 3: 57, 6: 29, 7: 29, 14: 29, 15: 29 };

/** CIP-19 pointer: three variable length naturals after the credential, 7 bits per byte, high bit continues. All bytes must be used. */
function isCompletePointer(address: Uint8Array): boolean {
  let i = 29;
  for (let n = 0; n < 3; n++) {
    let closed = false;
    while (i < address.length) {
      const byte = address[i++]!;
      if ((byte & 0x80) === 0) {
        closed = true;
        break;
      }
    }
    if (!closed) return false;
  }
  return i === address.length;
}

/**
 * Header type, network tag and the 28 byte credential of a Shelley address,
 * after checking its length for the type and, for pointers, the pointer
 * itself. Byron (type 8) already throws InvalidRequest here, callers that
 * want to handle it differently must check the header before calling.
 */
export function readShelleyAddress(address: Uint8Array): { type: number; networkTag: number; credential: Uint8Array } {
  const header = address[0];
  if (header === undefined || address.length < 29) throw apiError(APIErrorCode.InvalidRequest, 'addr is not an address');
  const type = header >> 4;
  if (type > 7 && type !== 14 && type !== 15) throw apiError(APIErrorCode.InvalidRequest, 'addr has an unknown address type');
  const expected = LENGTH[type];
  const lengthOk = type === 4 || type === 5 ? isCompletePointer(address) : address.length === expected;
  if (!lengthOk) throw apiError(APIErrorCode.InvalidRequest, 'addr has the wrong length or an incomplete pointer for its type');
  return { type, networkTag: networkTag(address), credential: paymentHash(address) };
}

/**
 * The 28-byte key credential an address carries: the hash itself for a bare
 * 28-byte input, the payment, stake or DRep credential for a key address
 * (Shelley type 0, 2, 4, 6 or 14, after readShelleyAddress validation), or
 * nothing for a script address. Throws the way readShelleyAddress does for a
 * malformed or too-short address.
 */
export function keyCredentialOf(address: Uint8Array): Uint8Array | undefined {
  if (address.length === 28) return address;
  const { type, credential } = readShelleyAddress(address);
  return [0, 2, 4, 6, 14].includes(type) ? credential : undefined;
}

export function resolveDataSigner(address: Uint8Array, keys: DataSignerKeys, mode: 'cip30' | 'cip95'): ResolvedSigner {
  if (address.length === 28) {
    if (mode !== 'cip95') throw apiError(APIErrorCode.InvalidRequest, 'addr is a bare key hash, not an address');
    if (!bytesEqual(address, keys.drepHash)) throw dataSignError(DataSignErrorCode.ProofGeneration, 'the wallet does not hold the key for this DRep ID');
    return { role: 'drep', key: keys.drep, publicKey: keys.drepPub, headerAddress: address, drepForm: 'bare' };
  }
  if (isByronAddress(address)) throw dataSignError(DataSignErrorCode.ProofGeneration, 'the wallet holds no Byron keys');
  if (address.length === 29 && (address[0] === 0x22 || address[0] === 0x23)) {
    throw apiError(APIErrorCode.InvalidRequest, 'addr is a CIP-129 governance id, not an address, pass the bare DRep ID or a type 6 address instead');
  }
  const credential = keyCredentialOf(address);
  if (credential === undefined) throw dataSignError(DataSignErrorCode.AddressNotPK, 'the address has a script credential');
  const type = address[0]! >> 4;
  if (networkTag(address) !== keys.networkId) throw dataSignError(DataSignErrorCode.ProofGeneration, 'the address is on another network');
  if (type === 14) {
    if (bytesEqual(credential, keys.stakeHash)) return { role: 'stake', key: keys.stake, publicKey: keys.stakePub, headerAddress: address };
    throw dataSignError(DataSignErrorCode.ProofGeneration, 'the wallet does not hold the stake key for this address');
  }
  if (bytesEqual(credential, keys.paymentHash)) return { role: 'payment', key: keys.payment, publicKey: keys.paymentPub, headerAddress: address };
  if (mode === 'cip95' && type === 6 && bytesEqual(credential, keys.drepHash)) {
    return { role: 'drep', key: keys.drep, publicKey: keys.drepPub, headerAddress: address, drepForm: 'type6' };
  }
  throw dataSignError(DataSignErrorCode.ProofGeneration, 'the wallet does not hold the payment key for this address');
}
