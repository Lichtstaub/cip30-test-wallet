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

export interface ParsedVoter {
  type: bigint;
  hash: Uint8Array;
}

export interface ParsedProposal {
  actionIndex: bigint;
  /** parameter_change (0) and treasury_withdrawals (2) may name a guardrail script the ledger runs. */
  guardrail?: Uint8Array;
}

export interface ParsedBody {
  inputs: TxInput[];
  requiredSigners: Uint8Array[];
  /** One entry per withdrawal, in map order. hash is the 28 byte stake credential. */
  withdrawals: { hash: Uint8Array; isScript: boolean }[];
  /** Every top-level body map key, in map order. Used to reject unsupported transaction forms. */
  bodyKeys: bigint[];
  /** Every certificate as its raw CBOR array, in body order. requirements.ts owns the witness table. */
  certificates: CborValue[][];
  /** One entry per voter key of the voting procedures map, in map order. */
  voters: ParsedVoter[];
  proposals: ParsedProposal[];
}

const BODY_INPUTS = 0n;
const BODY_CERTIFICATES = 4n;
const BODY_WITHDRAWALS = 5n;
const BODY_REQUIRED_SIGNERS = 14n;
const BODY_VOTING_PROCEDURES = 19n;
const BODY_PROPOSAL_PROCEDURES = 20n;

function mapGet(map: Map<CborValue, CborValue>, key: bigint): CborValue | undefined {
  return map.get(key);
}

/** Conway sets may be plain arrays or tag 258 around an array. No other tag is a set. */
export function unwrapSet(value: CborValue | undefined): CborValue[] {
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

  const rawCertificates = mapGet(body, BODY_CERTIFICATES);
  // Only the index is checked here. Pre-Conway certificates 5 and 6 are
  // recognised by their index alone, requirements.ts checks every other field.
  const certificates = unwrapSet(rawCertificates).map((c) => {
    if (!Array.isArray(c) || c.length < 1 || typeof c[0] !== 'bigint') throw new Error('malformed certificate');
    return c;
  });
  if (rawCertificates !== undefined && certificates.length === 0) throw new Error('certificates must not be empty');

  const voters: ParsedVoter[] = [];
  const rawVotes = mapGet(body, BODY_VOTING_PROCEDURES);
  if (rawVotes !== undefined) {
    if (!(rawVotes instanceof Map)) throw new Error('voting procedures must be a map');
    if (rawVotes.size === 0) throw new Error('voting procedures must not be empty');
    for (const [voter, votes] of rawVotes) {
      if (!Array.isArray(voter) || voter.length !== 2 || typeof voter[0] !== 'bigint') throw new Error('malformed voter');
      // voting_procedures = {+ voter => {+ gov_action_id => voting_procedure}}
      if (!(votes instanceof Map) || votes.size === 0) throw new Error('a voter must cast at least one vote');
      voters.push({ type: voter[0], hash: asBytes(voter[1], 'voter hash') });
    }
  }

  const rawProposals = mapGet(body, BODY_PROPOSAL_PROCEDURES);
  const proposals = unwrapSet(rawProposals).map((p): ParsedProposal => {
    if (!Array.isArray(p) || p.length !== 4) throw new Error('malformed proposal procedure');
    const action = p[2];
    if (!Array.isArray(action) || typeof action[0] !== 'bigint') throw new Error('malformed governance action');
    const actionIndex = action[0];
    // parameter_change_action = (0, prev, update, guardrail / nil)
    // The action's own field count is not checked, only where the guardrail sits.
    // treasury_withdrawals_action = (2, withdrawals, guardrail / nil)
    const last = action[action.length - 1];
    if (actionIndex === 0n || actionIndex === 2n) {
      if (last !== null && !(last instanceof Uint8Array)) throw new Error('malformed governance action');
      return last === null ? { actionIndex } : { actionIndex, guardrail: last };
    }
    return { actionIndex };
  });
  if (rawProposals !== undefined && proposals.length === 0) throw new Error('proposal procedures must not be empty');

  return {
    inputs,
    requiredSigners,
    withdrawals,
    bodyKeys: [...body.keys()].map((k) => {
      if (typeof k !== 'bigint') throw new Error('transaction body key must be an integer');
      return k;
    }),
    certificates,
    voters,
    proposals,
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
