import { blake2b } from '@noble/hashes/blake2.js';
import { Tagged, arrayItemRanges, decode, decodeItem, mapValueOffsets, readHeader, type CborValue } from './decode.js';
import { encode } from './encode.js';
import type { Utxo } from '../ledger.js';
import { isPlutusDataBytes } from '../cbor-shapes.js';
import { isScriptRef, providedScript, type ProvidedScript, type ScriptLanguage } from '../scripts.js';
import { MAX_INT64, MIN_INT64, valueFromCbor } from '../value.js';

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

/** Every input the transaction spends or puts at risk, body inputs first and then collateral inputs. The one source of that order. */
export function spentInputs(body: ParsedBody): Array<{ input: TxInput; label: 'input' | 'collateral input' }> {
  return [
    ...body.inputs.map((input) => ({ input, label: 'input' as const })),
    ...body.collateralInputs.map((input) => ({ input, label: 'collateral input' as const })),
  ];
}

export type InputLabel = 'input' | 'collateral input' | 'reference input';

/** Every input the ledger must know: the spent inputs in spentInputs order, then the reference inputs, which are read and never spent. */
export function lookupInputs(body: ParsedBody): Array<{ input: TxInput; label: InputLabel }> {
  return [...spentInputs(body), ...body.referenceInputs.map((input) => ({ input, label: 'reference input' as const }))];
}

/** A transaction output as the ledger will hold it, before it has an outpoint. */
export type TxOutput = Omit<Utxo, 'input'>;

export interface ParsedBody {
  inputs: TxInput[];
  /** Collateral inputs (body key 13), spent only when a script fails. */
  collateralInputs: TxInput[];
  /** Transaction outputs (body key 1), in order. Output i becomes txId#i. */
  outputs: TxOutput[];
  /** Collateral return (body key 16), created at txId#outputs.length when the transaction fails phase 2. */
  collateralReturn: TxOutput | undefined;
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
  /** Reference inputs (body key 18), read for their scripts and datums, never spent. */
  referenceInputs: TxInput[];
  /** Policy ids of the mint field (body key 9), in map order. */
  mintPolicies: Uint8Array[];
  /** ttl (body key 3), the first slot in which the transaction is no longer valid. */
  ttl: bigint | undefined;
  /** Validity interval start (body key 8). */
  validityStart: bigint | undefined;
}

const BODY_INPUTS = 0n;
const BODY_OUTPUTS = 1n;
const BODY_COLLATERAL_INPUTS = 13n;
const BODY_COLLATERAL_RETURN = 16n;
const BODY_TOTAL_COLLATERAL = 17n;
const BODY_CERTIFICATES = 4n;
const BODY_WITHDRAWALS = 5n;
const BODY_REQUIRED_SIGNERS = 14n;
const BODY_VOTING_PROCEDURES = 19n;
const BODY_PROPOSAL_PROCEDURES = 20n;
const BODY_TTL = 3n;
const BODY_VALIDITY_START = 8n;
const BODY_MINT = 9n;
const BODY_REFERENCE_INPUTS = 18n;

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

function parseInputs(value: CborValue | undefined): TxInput[] {
  return unwrapSet(value).map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('malformed transaction input');
    const [txId, index] = item;
    if (typeof index !== 'bigint') throw new Error('malformed input index');
    return { txId: asBytes(txId, 'input tx id'), index };
  });
}

/** nonempty_set<transaction_input>, empty when the field is absent. */
function parseNonEmptyInputs(value: CborValue | undefined, what: string): TxInput[] {
  const inputs = parseInputs(value);
  if (value !== undefined && inputs.length === 0) throw new Error(`${what} must not be empty`);
  return inputs;
}

/** A uint field (slot or coin), undefined when absent. */
function parseSlot(value: CborValue | undefined, what: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`malformed ${what}`);
  return value;
}

// mint = {+ policy_id => {+ asset_name => nonzero_int64}}
function parseMint(value: CborValue | undefined): Uint8Array[] {
  if (value === undefined) return [];
  if (!(value instanceof Map) || value.size === 0) throw new Error('mint must be a non-empty map');
  const policies: Uint8Array[] = [];
  for (const [policy, assets] of value) {
    if (!(policy instanceof Uint8Array) || policy.length !== 28) throw new Error('malformed mint policy id');
    if (!(assets instanceof Map) || assets.size === 0) throw new Error('a mint policy must name at least one asset');
    for (const [name, quantity] of assets) {
      if (!(name instanceof Uint8Array) || name.length > 32) throw new Error('malformed mint asset name');
      if (typeof quantity !== 'bigint' || quantity === 0n || quantity < MIN_INT64 || quantity > MAX_INT64) {
        throw new Error('mint quantity must be a nonzero int64');
      }
    }
    policies.push(policy);
  }
  return policies;
}

// transaction_output = [address, value, ? datum_hash] / {0: address, 1: value, ? 2: datum_option, ? 3: script_ref}
function parseOutput(output: CborValue, where: string): TxOutput {
  let address: CborValue | undefined;
  let value: CborValue | undefined;
  let datumHash: CborValue | undefined;
  let datumOption: CborValue | undefined;
  let scriptRef: CborValue | undefined;
  if (Array.isArray(output) && (output.length === 2 || output.length === 3)) {
    [address, value, datumHash] = output;
  } else if (output instanceof Map) {
    address = output.get(0n);
    value = output.get(1n);
    datumOption = output.get(2n);
    scriptRef = output.get(3n);
  } else {
    throw new Error(`malformed ${where}`);
  }
  if (!(address instanceof Uint8Array) || address.length === 0) throw new Error(`malformed address in ${where}`);
  if (value === undefined) throw new Error(`${where} has no value`);
  const { coin, assets } = valueFromCbor(value, `value in ${where}`, true);
  const out: TxOutput = { address, lovelace: coin };
  if (assets.size > 0) out.assets = assets;
  if (datumHash !== undefined) {
    if (!(datumHash instanceof Uint8Array) || datumHash.length !== 32) throw new Error(`malformed datum hash in ${where}`);
    out.datum = { kind: 'hash', hash: datumHash };
  }
  if (datumOption !== undefined) {
    // datum_option = [0, hash32] / [1, #6.24(bytes .cbor plutus_data)]
    const [kind, content] = Array.isArray(datumOption) && datumOption.length === 2 ? datumOption : [];
    if (kind === 0n && content instanceof Uint8Array && content.length === 32) out.datum = { kind: 'hash', hash: content };
    else if (kind === 1n && content instanceof Tagged && content.tag === 24n && content.value instanceof Uint8Array && isPlutusDataBytes(content.value)) {
      out.datum = { kind: 'inline', cbor: content.value };
    } else throw new Error(`malformed datum option in ${where}`);
  }
  if (scriptRef !== undefined) {
    // script_ref = #6.24(bytes .cbor script)
    if (!(scriptRef instanceof Tagged) || scriptRef.tag !== 24n || !(scriptRef.value instanceof Uint8Array)) throw new Error(`malformed script ref in ${where}`);
    if (!isScriptRef(scriptRef.value)) throw new Error(`malformed script ref in ${where}`);
    out.scriptRef = scriptRef.value;
  }
  return out;
}

function parseBodyMap(body: Map<CborValue, CborValue>): ParsedBody {
  // The decoder turns CBOR undefined (0xf7) into undefined, which mapGet cannot tell from a missing key.
  for (const [key, value] of body) {
    if (value === undefined) throw new Error(`body key ${String(key)} must not be undefined`);
  }

  const inputs = parseInputs(mapGet(body, BODY_INPUTS));

  const rawOutputs = mapGet(body, BODY_OUTPUTS) ?? [];
  if (!Array.isArray(rawOutputs)) throw new Error('outputs must be an array');
  const outputs = rawOutputs.map((output, i) => parseOutput(output, `output ${i}`));

  const collateralInputs = parseNonEmptyInputs(mapGet(body, BODY_COLLATERAL_INPUTS), 'collateral inputs');
  const rawReturn = mapGet(body, BODY_COLLATERAL_RETURN);
  const collateralReturn = rawReturn === undefined ? undefined : parseOutput(rawReturn, 'collateral return');
  parseSlot(mapGet(body, BODY_TOTAL_COLLATERAL), 'total collateral');

  // nonempty_set<transaction_input>
  const referenceInputs = parseNonEmptyInputs(mapGet(body, BODY_REFERENCE_INPUTS), 'reference inputs');
  const mintPolicies = parseMint(mapGet(body, BODY_MINT));
  const ttl = parseSlot(mapGet(body, BODY_TTL), 'ttl');
  const validityStart = parseSlot(mapGet(body, BODY_VALIDITY_START), 'validity interval start');

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
    collateralInputs,
    outputs,
    collateralReturn,
    requiredSigners,
    withdrawals,
    bodyKeys: [...body.keys()].map((k) => {
      if (typeof k !== 'bigint') throw new Error('transaction body key must be an integer');
      return k;
    }),
    certificates,
    voters,
    proposals,
    referenceInputs,
    mintPolicies,
    ttl,
    validityStart,
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

// Witness set keys that carry scripts, with the language tag the ledger hashes them under.
const WITNESS_SCRIPTS: Array<[bigint, ScriptLanguage]> = [
  [1n, 0],
  [3n, 1],
  [6n, 2],
  [7n, 3],
];

/** Every script the witness set carries, read from the original bytes so a native script hashes the way the ledger hashes it. */
function witnessScripts(tx: Uint8Array, witnessSetOffset: number): ProvidedScript[] {
  const offsets = mapValueOffsets(tx, witnessSetOffset);
  const scripts: ProvidedScript[] = [];
  for (const [key, language] of WITNESS_SCRIPTS) {
    const at = offsets.get(key);
    if (at === undefined) continue;
    const { ranges } = arrayItemRanges(tx, at, true);
    // nonempty_list / nonempty_set in the Conway CDDL
    if (ranges.length === 0) throw new Error(`script list in witness set key ${key} must not be empty`);
    for (const [start, end] of ranges) scripts.push(providedScript(language, tx.slice(start, end)));
  }
  return scripts;
}

export interface ParsedTransaction {
  /** The body exactly as the builder encoded it, never re-encoded. */
  bodyBytes: Uint8Array;
  /** The is_valid flag: false means phase 2 failed and only the collateral is spent. */
  isValid: boolean;
  /** Blake2b-256 of bodyBytes, the transaction id and what every witness signs. */
  hash: Uint8Array;
  body: ParsedBody;
  /** VKey witnesses already in the transaction (witness set key 0). */
  vkeyWitnesses: VKeyWitness[];
  /** Scripts in the witness set (keys 1, 3, 6, 7), in key order. */
  scripts: ProvidedScript[];
}

/**
 * The single entry point for a transaction from outside: signTx, submitTx,
 * the ledger and expectSignedBy all go through it, so one shape rule covers
 * every path. It accepts one complete CBOR item shaped like a transaction,
 * [body map, witness set map, is_valid boolean, auxiliary data], with nothing
 * after it. Auxiliary data is null, a map (Shelley), an array (Allegra,
 * [metadata, native scripts]) or a tagged value (Alonzo and later). Fees,
 * validity and script execution belong to the ledger checks in Node, this parser
 * only reads the scripts. Throws a plain Error on anything else, callers turn
 * that into their own error shape.
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
  // The body is the first item after the array header, definite or not, the witness set follows it.
  const start = readHeader(tx, 0).next;
  const bodyEnd = decodeItem(tx, start).next;
  const bodyBytes = tx.slice(start, bodyEnd);
  return {
    bodyBytes,
    isValid,
    hash: blake2b(bodyBytes, { dkLen: 32 }),
    body: parseBodyMap(body),
    vkeyWitnesses: vkeyWitnessesOf(witnessSet),
    scripts: witnessScripts(tx, bodyEnd),
  };
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
