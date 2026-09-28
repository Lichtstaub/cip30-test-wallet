import { blake2b } from '@noble/hashes/blake2.js';
import { Tagged, decode, decodeItem, readHeader, type CborValue } from './decode.js';
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

function mapGet(map: Map<CborValue, CborValue>, key: bigint): CborValue | undefined {
  return map.get(key);
}

/** Conway sets may be plain arrays or tag 258 around an array. No other tag is a set. */
function unwrapSet(value: CborValue | undefined): CborValue[] {
  if (value === undefined) return [];
  if (value instanceof Tagged) {
    if (value.tag !== 258n || !Array.isArray(value.value)) throw new Error('expected a CBOR array or a tag 258 set');
    return value.value;
  }
  if (!Array.isArray(value)) throw new Error('expected a CBOR array or a tag 258 set');
  return value;
}

function asBytes(value: CborValue, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`expected bytes for ${what}`);
  return value;
}

function parseBodyMap(body: Map<CborValue, CborValue>): ParsedBody {
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

function vkeyWitnessesOf(witnessSet: Map<CborValue, CborValue>): VKeyWitness[] {
  return unwrapSet(mapGet(witnessSet, WITNESS_VKEYS)).map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('malformed vkey witness');
    return { vkey: asBytes(item[0], 'witness vkey'), signature: asBytes(item[1], 'witness signature') };
  });
}

export interface ParsedTransaction {
  /** The body exactly as the builder encoded it, never re-encoded. */
  bodyBytes: Uint8Array;
  /** Blake2b-256 of bodyBytes, the transaction id and what every witness signs. */
  hash: Uint8Array;
  body: ParsedBody;
  /** VKey witnesses already in the transaction (witness set key 0). */
  vkeyWitnesses: VKeyWitness[];
}

/**
 * The single entry point for a transaction from outside: signTx, submitTx,
 * the ledger and expectSignedBy all go through it, so one shape rule covers
 * every path. It accepts one complete CBOR item shaped like a transaction,
 * [body map, witness set map, is_valid boolean, auxiliary data], with nothing
 * after it. Auxiliary data is null, a map (Shelley), an array (Allegra,
 * [metadata, native scripts]) or a tagged value (Alonzo and later). Fees,
 * validity and scripts are not checked. Throws a plain Error on anything
 * else, callers turn that into their own error shape.
 */
export function parseTransaction(tx: Uint8Array): ParsedTransaction {
  // decode() rejects trailing bytes and handles both array forms.
  const top = decode(tx);
  if (!Array.isArray(top) || top.length !== 4) throw new Error('not a transaction: expected a CBOR array of 4 items');
  const [body, witnessSet, isValid, aux] = top;
  if (!(body instanceof Map)) throw new Error('not a transaction: body must be a cbor map');
  if (!(witnessSet instanceof Map)) throw new Error('not a transaction: witness set must be a cbor map');
  if (typeof isValid !== 'boolean') throw new Error('not a transaction: is_valid must be a boolean');
  if (!(aux === null || aux instanceof Map || Array.isArray(aux) || aux instanceof Tagged)) {
    throw new Error('not a transaction: auxiliary data must be null, a map, an array or a tagged value');
  }
  // The body is the first item after the array header, definite or not.
  const start = readHeader(tx, 0).next;
  const bodyBytes = tx.slice(start, decodeItem(tx, start).next);
  return { bodyBytes, hash: blake2b(bodyBytes, { dkLen: 32 }), body: parseBodyMap(body), vkeyWitnesses: vkeyWitnessesOf(witnessSet) };
}

export function txHash(tx: Uint8Array): Uint8Array {
  return parseTransaction(tx).hash;
}

// transaction_witness_set = { ? 0: nonempty_set<vkeywitness>, ... }
// Conway allows the set as a plain array or as tag 258. The plain array is
// accepted by every consumer we know, so that is what we emit.
export function encodeWitnessSet(witnesses: VKeyWitness[]): Uint8Array {
  const map = new Map<bigint, unknown>();
  if (witnesses.length > 0) map.set(0n, witnesses.map((w) => [w.vkey, w.signature]));
  return encode(map as never);
}
