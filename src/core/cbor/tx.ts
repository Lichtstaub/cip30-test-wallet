import { blake2b } from '@noble/hashes/blake2.js';
import { Tagged, decodeItem, readHeader, type CborValue } from './decode.js';
import { encode } from './encode.js';

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
  /** One entry per withdrawal, in map order. hash is the 28 byte stake credential. */
  withdrawals: { hash: Uint8Array; isScript: boolean }[];
  /** Every top-level body map key, in map order. Used to reject unsupported transaction forms. */
  bodyKeys: bigint[];
}

const BODY_INPUTS = 0n;
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
  if (top.indefinite) {
    // Definite-length arrays already carry their item count in the header.
    // An indefinite-length array does not, so walk the remaining items up
    // to the break byte and count them instead.
    let count = 1;
    let p = end;
    while (tx[p] !== 0xff) {
      count++;
      p = decodeItem(tx, p).next;
    }
    if (count !== 4) throw new Error('not a transaction: expected a CBOR array of 4 items');
  }
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

  const rawWithdrawals = mapGet(body, BODY_WITHDRAWALS);
  const withdrawals: { hash: Uint8Array; isScript: boolean }[] = [];
  if (rawWithdrawals instanceof Map) {
    for (const key of rawWithdrawals.keys()) {
      const rewardAddress = asBytes(key, 'withdrawal reward address');
      if (rewardAddress.length < 29) throw new Error('malformed withdrawal reward address');
      // reward address = 1 header byte + 28 byte credential hash
      const header = rewardAddress[0]!;
      withdrawals.push({ hash: rewardAddress.slice(1, 29), isScript: (header >> 4) === 0x0f });
    }
  }

  return {
    inputs,
    requiredSigners,
    withdrawals,
    bodyKeys: [...body.keys()].map((k) => {
      if (typeof k !== 'bigint') throw new Error('transaction body key must be an integer');
      return k;
    }),
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

// transaction_witness_set = { ? 0: nonempty_set<vkeywitness>, ... }
// Conway allows the set as a plain array or as tag 258. The plain array is
// accepted by every consumer we know, so that is what we emit.
export function encodeWitnessSet(witnesses: VKeyWitness[]): Uint8Array {
  const map = new Map<bigint, unknown>();
  if (witnesses.length > 0) map.set(0n, witnesses.map((w) => [w.vkey, w.signature]));
  return encode(map as never);
}
