import { blake2b } from '@noble/hashes/blake2.js';
import { Tagged, decodeItem, readHeader, type CborValue } from './decode.js';

// A Cardano transaction is [body, witness_set, is_valid, auxiliary_data].
// The body is never re-encoded here. Hash and signature run over the exact
// bytes the builder produced, which is the only thing a node will verify.

export interface TxInput {
  txId: Uint8Array;
  index: bigint;
}

export interface ParsedBody {
  inputs: TxInput[];
  requiredSigners: Uint8Array[];
  /** Stake key hashes of every withdrawal reward address (28 bytes each). */
  withdrawalStakeHashes: Uint8Array[];
  hasCertificates: boolean;
}

const BODY_INPUTS = 0n;
const BODY_CERTIFICATES = 4n;
const BODY_WITHDRAWALS = 5n;
const BODY_REQUIRED_SIGNERS = 14n;

export function mapGet(map: Map<CborValue, CborValue>, key: bigint): CborValue | undefined {
  return map.get(key);
}

/** Bounds of the body item inside the top-level transaction array. */
function bodyBounds(tx: Uint8Array): { start: number; end: number } {
  const top = readHeader(tx, 0);
  if (top.major !== 4 || (!top.indefinite && top.arg !== 4n)) {
    throw new Error('not a transaction: expected a CBOR array of 4 items');
  }
  const start = top.next;
  const { next: end } = decodeItem(tx, start);
  return { start, end };
}

export function extractBodyBytes(tx: Uint8Array): Uint8Array {
  const { start, end } = bodyBounds(tx);
  return tx.slice(start, end);
}

export function txHash(tx: Uint8Array): Uint8Array {
  return blake2b(extractBodyBytes(tx), { dkLen: 32 });
}

/** Conway sets may be plain arrays or tag 258 around an array. */
function unwrapSet(value: CborValue | undefined): CborValue[] {
  if (value === undefined) return [];
  const inner = value instanceof Tagged ? value.value : value;
  if (!Array.isArray(inner)) throw new Error('expected a CBOR array or tagged set');
  return inner;
}

function asBytes(value: CborValue, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`expected bytes for ${what}`);
  return value;
}

export function parseBody(tx: Uint8Array): ParsedBody {
  const { start } = bodyBounds(tx);
  const body = decodeItem(tx, start).value;
  if (!(body instanceof Map)) throw new Error('transaction body must be a CBOR map');

  const inputs = unwrapSet(mapGet(body, BODY_INPUTS)).map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('malformed transaction input');
    const [txId, index] = item;
    if (typeof index !== 'bigint') throw new Error('malformed input index');
    return { txId: asBytes(txId, 'input tx id'), index };
  });

  const requiredSigners = unwrapSet(mapGet(body, BODY_REQUIRED_SIGNERS)).map((k) => asBytes(k, 'required signer'));

  const withdrawals = mapGet(body, BODY_WITHDRAWALS);
  const withdrawalStakeHashes: Uint8Array[] = [];
  if (withdrawals instanceof Map) {
    for (const key of withdrawals.keys()) {
      const rewardAddress = asBytes(key, 'withdrawal reward address');
      // reward address = 1 header byte + 28 byte credential hash
      withdrawalStakeHashes.push(rewardAddress.slice(1, 29));
    }
  }

  return {
    inputs,
    requiredSigners,
    withdrawalStakeHashes,
    hasCertificates: mapGet(body, BODY_CERTIFICATES) !== undefined,
  };
}

export interface VKeyWitness {
  vkey: Uint8Array;
  signature: Uint8Array;
}

const WITNESS_VKEYS = 0n;

/** VKey witnesses already present in the transaction (item 1, key 0). */
export function existingVKeyWitnesses(tx: Uint8Array): VKeyWitness[] {
  const { end: bodyEnd } = bodyBounds(tx);
  const witnessSet = decodeItem(tx, bodyEnd).value;
  if (!(witnessSet instanceof Map)) throw new Error('transaction witness set must be a CBOR map');
  return unwrapSet(mapGet(witnessSet, WITNESS_VKEYS)).map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('malformed vkey witness');
    return { vkey: asBytes(item[0], 'witness vkey'), signature: asBytes(item[1], 'witness signature') };
  });
}
