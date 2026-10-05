import { blake2b } from '@noble/hashes/blake2.js';
import { networkTag } from '../../core/addresses.js';
import { bytesToHex } from '../../core/bytes.js';
import { isPlutusDataBytes } from '../../core/cbor-shapes.js';
import { arrayItemRanges, decode, decodeItem, mapValueOffsets, readHeader, type CborValue } from '../../core/cbor/decode.js';
import { unwrapSet, type ParsedTransaction, type TxOutput } from '../../core/cbor/tx.js';
import { CERTIFICATE_ARITY, certificateName } from '../../core/requirements.js';
import { scriptHash } from '../../core/scripts.js';
import { addAsset, MAX_INT64, type MultiAsset } from '../../core/value.js';

// What the ledger rules need from a transaction beyond what the page parser
// reads: amounts, byte sizes, certificates, redeemers with their data, Plutus
// scripts, datums, the script data hash and the auxiliary data hash.
// Everything comes from the original bytes, only a value's size is counted as
// the ledger would serialize it again.
// Field layout after the Conway CDDL (eras/conway/impl/cddl/data/conway.cddl).

export interface Credential {
  isScript: boolean;
  hash: Uint8Array;
}

export function credentialKey(c: Credential): string {
  return `${c.isScript ? 'script' : 'key'}:${bytesToHex(c.hash)}`;
}

/** The network a node reads from an address header: bit 0 (Address.hs headerNetworkId), 0 testnet, 1 mainnet. */
export function headerNetwork(address: Uint8Array): 0 | 1 {
  return (networkTag(address) & 1) as 0 | 1;
}

/** The credential of a reward account: header type 15 is a script, 14 a key. The hash follows the header. */
export function accountCredential(account: Uint8Array): Credential {
  return { isScript: account[0]! >> 4 === 15, hash: account.slice(1) };
}

export type CertFact =
  | { kind: 'accountRegistration'; cert: 0n | 7n | 11n | 12n | 13n; credential: Credential; deposit: bigint | undefined }
  | { kind: 'accountUnregistration'; cert: 1n | 8n; credential: Credential; refund: bigint | undefined }
  | { kind: 'delegation'; cert: 2n | 9n | 10n; credential: Credential }
  | { kind: 'poolRegistration'; cert: 3n; poolId: Uint8Array }
  | { kind: 'poolRetirement'; cert: 4n; poolId: Uint8Array }
  | { kind: 'drepRegistration'; cert: 16n; credential: Credential; deposit: bigint }
  | { kind: 'drepUnregistration'; cert: 17n; credential: Credential; refund: bigint }
  | { kind: 'drepUpdate'; cert: 18n; credential: Credential }
  | { kind: 'committee'; cert: 14n | 15n }
  | { kind: 'deprecated'; cert: 5n | 6n };

export interface SizedOutput {
  output: TxOutput;
  /** Bytes of the output exactly as it stands in the body, what min-UTxO counts. */
  size: number;
  /** Bytes of its value as the ledger serializes it, maps above 23 entries indefinite, what maxValSize limits. */
  valueSize: number;
}

export interface RedeemerFact {
  tag: bigint;
  index: bigint;
  mem: bigint;
  steps: bigint;
}

export interface TxFacts {
  /** sizeTxF: 1 + body + witness set + auxiliary data bytes, the size fee and maxTxSize use. */
  size: bigint;
  fee: bigint;
  outputs: SizedOutput[];
  collateralReturn: SizedOutput | undefined;
  totalCollateral: bigint | undefined;
  networkId: bigint | undefined;
  withdrawals: Array<{ rewardAddress: Uint8Array; credential: Credential; amount: bigint }>;
  /** Mint quantities with sign, burns negative. Empty map when absent. */
  mint: MultiAsset;
  treasuryDonation: bigint;
  currentTreasuryValue: bigint | undefined;
  certificates: CertFact[];
  /** Deposit field and reward account bytes (header and credential, 29 bytes) of every proposal procedure, in body order. */
  proposals: Array<{ deposit: bigint; returnAccount: Uint8Array }>;
  /** declaredHash: body key 7. computedHash: Blake2b-256 over the original bytes of the auxiliary data, undefined when it is null. */
  auxiliaryData: { declaredHash: Uint8Array | undefined; computedHash: Uint8Array | undefined };
  redeemers: RedeemerFact[];
  /** The data of every redeemer as the original plutus_data bytes, in the order and with the dedupe of redeemers. */
  redeemerData: Array<{ tag: bigint; index: bigint; data: Uint8Array }>;
  /** Witness set key 5 in its original bytes, what the script integrity hash covers. */
  redeemersBytes: Uint8Array | undefined;
  /** Plutus scripts of witness set keys 3, 6 and 7 in key order, each hash once. bytes is the content of the CBOR byte string. */
  plutusScripts: Array<{ language: 1 | 2 | 3; hash: Uint8Array; bytes: Uint8Array }>;
  /** Witness set key 4, each hash once. hash is Blake2b-256 over the original bytes of the datum. */
  datums: Array<{ hash: Uint8Array; bytes: Uint8Array }>;
  /** Witness set key 4 in its original bytes, what the script integrity hash covers. */
  datumsBytes: Uint8Array | undefined;
  /** script_data_hash, body key 11. */
  scriptDataHash: Uint8Array | undefined;
  bootstrapWitnesses: number;
}

const BODY_OUTPUTS = 1n;
const BODY_FEE = 2n;
const BODY_CERTIFICATES = 4n;
const BODY_WITHDRAWALS = 5n;
const BODY_AUXILIARY_DATA_HASH = 7n;
const BODY_MINT = 9n;
const BODY_SCRIPT_DATA_HASH = 11n;
const BODY_NETWORK_ID = 15n;
const BODY_COLLATERAL_RETURN = 16n;
const BODY_TOTAL_COLLATERAL = 17n;
const BODY_PROPOSAL_PROCEDURES = 20n;
const BODY_CURRENT_TREASURY = 21n;
const BODY_DONATION = 22n;
const WITNESS_BOOTSTRAP = 2n;
const WITNESS_DATUMS = 4n;
const WITNESS_REDEEMERS = 5n;
// Witness set keys of Plutus V1, V2 and V3 scripts with their language.
const WITNESS_PLUTUS_SCRIPTS: Array<[bigint, 1 | 2 | 3]> = [
  [3n, 1],
  [6n, 2],
  [7n, 3],
];
const CBOR_NULL = 0xf6;
const CBOR_BREAK = 0xff;

// uint .size 4, the redeemer index
const MAX_UINT32 = 0xffffffffn;

function malformed(what: string): never {
  throw new Error(`malformed ${what}`);
}

function coin(value: CborValue | undefined, what: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) malformed(what);
  return value;
}

function optionalCoin(value: CborValue | undefined, what: string): bigint | undefined {
  return value === undefined ? undefined : coin(value, what);
}

function hash28(value: CborValue | undefined, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 28) malformed(what);
  return value;
}

// credential = [0, addr_keyhash // 1, script_hash]. 'malformed credential in <where>' for the shape and
// 'malformed credential hash in <where>' for the hash, the words of requirements().
function credential(value: CborValue | undefined, where: string, name = 'credential'): Credential {
  if (!Array.isArray(value) || value.length !== 2 || (value[0] !== 0n && value[0] !== 1n)) malformed(`${name} in ${where}`);
  return { isScript: value[0] === 1n, hash: hash28(value[1], `${name} hash in ${where}`) };
}

// drep = [0, addr_keyhash // 1, script_hash // 2 // 3]
function checkDRep(value: CborValue | undefined, what: string): void {
  if (!Array.isArray(value)) malformed(what);
  if ((value[0] === 0n || value[0] === 1n) && value.length === 2) hash28(value[1], what);
  else if (!((value[0] === 2n || value[0] === 3n) && value.length === 1)) malformed(what);
}

// anchor = [anchor_url : url, anchor_data_hash : hash32], optional as anchor / nil
function checkOptionalAnchor(value: CborValue | undefined, what: string): void {
  if (value === null) return;
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !(value[1] instanceof Uint8Array) || value[1].length !== 32) {
    malformed(what);
  }
}

function readCertificate(raw: CborValue): CertFact {
  if (!Array.isArray(raw) || typeof raw[0] !== 'bigint') malformed('certificate');
  const index = raw[0];
  // Conway TxCert.hs refuses 5 (genesis delegation) and 6 (MIR) when decoding. They are
  // kept here so the caller can name them instead of reporting a malformed transaction.
  if (index === 5n || index === 6n) return { kind: 'deprecated', cert: index };
  // One arity table, one naming and one credential wording with requirements(), so both report a wrong
  // field count or a malformed credential in the same words. The other fields only the reader checks.
  const arity = CERTIFICATE_ARITY[index.toString()];
  if (arity === undefined) throw new Error(`unknown certificate ${index}`);
  const where = certificateName(index);
  if (raw.length !== arity) malformed(where);
  const stake = () => credential(raw[1], where);
  const pool = (at: number) => hash28(raw[at], `pool key hash in ${where}`);
  const drep = (at: number) => checkDRep(raw[at], `drep in ${where}`);
  switch (index) {
    case 0n:
      return { kind: 'accountRegistration', cert: 0n, credential: stake(), deposit: undefined };
    case 7n:
      return { kind: 'accountRegistration', cert: 7n, credential: stake(), deposit: coin(raw[2], `deposit in ${where}`) };
    case 11n:
      pool(2);
      return { kind: 'accountRegistration', cert: 11n, credential: stake(), deposit: coin(raw[3], `deposit in ${where}`) };
    case 12n:
      drep(2);
      return { kind: 'accountRegistration', cert: 12n, credential: stake(), deposit: coin(raw[3], `deposit in ${where}`) };
    case 13n:
      pool(2);
      drep(3);
      return { kind: 'accountRegistration', cert: 13n, credential: stake(), deposit: coin(raw[4], `deposit in ${where}`) };
    case 1n:
      return { kind: 'accountUnregistration', cert: 1n, credential: stake(), refund: undefined };
    case 8n:
      return { kind: 'accountUnregistration', cert: 8n, credential: stake(), refund: coin(raw[2], `refund in ${where}`) };
    case 2n:
      pool(2);
      return { kind: 'delegation', cert: 2n, credential: stake() };
    case 9n:
      drep(2);
      return { kind: 'delegation', cert: 9n, credential: stake() };
    case 10n:
      pool(2);
      drep(3);
      return { kind: 'delegation', cert: 10n, credential: stake() };
    case 3n:
      // pool_registration_cert = (3, pool_params), operator first. The other eight fields are not read.
      return { kind: 'poolRegistration', cert: 3n, poolId: pool(1) };
    case 4n:
      coin(raw[2], `epoch in ${where}`);
      return { kind: 'poolRetirement', cert: 4n, poolId: pool(1) };
    case 14n:
      credential(raw[1], where);
      credential(raw[2], where, 'hot credential');
      return { kind: 'committee', cert: 14n };
    case 15n:
      credential(raw[1], where);
      checkOptionalAnchor(raw[2], `anchor in ${where}`);
      return { kind: 'committee', cert: 15n };
    case 16n:
      checkOptionalAnchor(raw[3], `anchor in ${where}`);
      return { kind: 'drepRegistration', cert: 16n, credential: stake(), deposit: coin(raw[2], `deposit in ${where}`) };
    case 17n:
      return { kind: 'drepUnregistration', cert: 17n, credential: stake(), refund: coin(raw[2], `refund in ${where}`) };
    default:
      // 18, the last index CERTIFICATE_ARITY knows
      checkOptionalAnchor(raw[2], `anchor in ${where}`);
      return { kind: 'drepUpdate', cert: 18n, credential: stake() };
  }
}

// ex_units = [mem : 0 .. max_int64, steps : 0 .. max_int64]
function exUnits(value: CborValue | undefined, what: string): { mem: bigint; steps: bigint } {
  if (!Array.isArray(value) || value.length !== 2) malformed(what);
  const [mem, steps] = value;
  if (typeof mem !== 'bigint' || typeof steps !== 'bigint' || mem < 0n || steps < 0n || mem > MAX_INT64 || steps > MAX_INT64) malformed(what);
  return { mem, steps };
}

// redeemer_tag = 0 .. 5, index : uint .size 4
function tagAndIndex(tag: CborValue | undefined, index: CborValue | undefined): { tag: bigint; index: bigint } {
  if (typeof tag !== 'bigint' || tag < 0n || tag > 5n) malformed('redeemer tag');
  if (typeof index !== 'bigint' || index < 0n || index > MAX_UINT32) malformed('redeemer index');
  return { tag, index };
}

type Range = [number, number];

/** Byte ranges of the key and the value of every entry of the CBOR map at offset, definite or indefinite. */
function mapEntryRanges(bytes: Uint8Array, offset: number): Array<{ key: Range; value: Range }> {
  const h = readHeader(bytes, offset);
  const entries: Array<{ key: Range; value: Range }> = [];
  let p = h.next;
  const entry = () => {
    const keyEnd = decodeItem(bytes, p).next;
    const valueEnd = decodeItem(bytes, keyEnd).next;
    entries.push({ key: [p, keyEnd], value: [keyEnd, valueEnd] });
    p = valueEnd;
  };
  if (h.indefinite) {
    while (bytes[p] !== CBOR_BREAK) entry();
  } else {
    for (let i = 0n; i < h.arg; i++) entry();
  }
  return entries;
}

/** The original bytes of one plutus_data item, refused when they are no plutus_data. */
function plutusData(bytes: Uint8Array, [start, end]: Range, what: string): Uint8Array {
  const data = bytes.slice(start, end);
  if (!isPlutusDataBytes(data)) malformed(what);
  return data;
}

interface RedeemerEntry {
  fact: RedeemerFact;
  data: Uint8Array;
}

// redeemers = [+ [tag, index, data, ex_units]] / {+ [tag, index] => [data, ex_units]}
// Alonzo TxWits.hs decodes both forms with Map.fromList, so a repeated (tag, index) collapses
// to one entry and the later wire entry wins. A JS Map keeps the position of the first
// occurrence and takes the later value, which is the same set of entries. The data keeps
// its original bytes, what a script receives and what the script integrity hash covers.
function readRedeemers(bytes: Uint8Array, at: number | undefined): RedeemerEntry[] {
  if (at === undefined) return [];
  const value = decodeItem(bytes, at).value;
  const byKey = new Map<string, RedeemerEntry>();
  const add = (fact: RedeemerFact, data: Uint8Array) => byKey.set(`${fact.tag}:${fact.index}`, { fact, data });
  if (Array.isArray(value)) {
    const { ranges } = arrayItemRanges(bytes, at, false);
    value.forEach((r, i) => {
      if (!Array.isArray(r) || r.length !== 4) malformed('redeemer');
      const fact = { ...tagAndIndex(r[0], r[1]), ...exUnits(r[3], 'redeemer ex units') };
      add(fact, plutusData(bytes, arrayItemRanges(bytes, ranges[i]![0], false).ranges[2]!, 'redeemer data'));
    });
  } else if (value instanceof Map) {
    const ranges = mapEntryRanges(bytes, at);
    [...value].forEach(([key, entry], i) => {
      if (!Array.isArray(key) || key.length !== 2) malformed('redeemer key');
      if (!Array.isArray(entry) || entry.length !== 2) malformed('redeemer');
      const fact = { ...tagAndIndex(key[0], key[1]), ...exUnits(entry[1], 'redeemer ex units') };
      add(fact, plutusData(bytes, arrayItemRanges(bytes, ranges[i]!.value[0], false).ranges[0]!, 'redeemer data'));
    });
  } else {
    malformed('redeemers');
  }
  return [...byKey.values()];
}

/** The original bytes of the item at offset, undefined when the key is absent. */
function itemBytes(bytes: Uint8Array, at: number | undefined): Uint8Array | undefined {
  return at === undefined ? undefined : bytes.slice(at, decodeItem(bytes, at).next);
}

// plutus_v1_script = bytes, plutus_v2_script and plutus_v3_script likewise, as a
// nonempty_set or a plain array. The page parser already refused an empty list
// and an empty or non-bytes script. Alonzo TxWits.hs keeps the scripts in a map
// by hash, so a repeated script counts once.
function readPlutusScripts(bytes: Uint8Array, offsets: Map<bigint, number>): TxFacts['plutusScripts'] {
  const byHash = new Map<string, TxFacts['plutusScripts'][number]>();
  for (const [key, language] of WITNESS_PLUTUS_SCRIPTS) {
    const at = offsets.get(key);
    if (at === undefined) continue;
    for (const [start, end] of arrayItemRanges(bytes, at, true).ranges) {
      const content = decode(bytes.slice(start, end));
      if (!(content instanceof Uint8Array) || content.length === 0) malformed(`Plutus V${language} script`);
      const hash = scriptHash(language, content);
      const hex = bytesToHex(hash);
      if (!byHash.has(hex)) byHash.set(hex, { language, hash, bytes: content });
    }
  }
  return [...byHash.values()];
}

// plutus_data in witness set key 4: nonempty_set<plutus_data>, a plain array or tag 258.
// Alonzo TxWits.hs hashes every datum over its original bytes (hashData) and keeps
// them in a map by that hash, so a repeated datum counts once.
function readDatums(bytes: Uint8Array, at: number | undefined): TxFacts['datums'] {
  if (at === undefined) return [];
  let ranges: Range[];
  try {
    ranges = arrayItemRanges(bytes, at, true).ranges;
  } catch {
    return malformed('datums');
  }
  if (ranges.length === 0) malformed('datums');
  const byHash = new Map<string, TxFacts['datums'][number]>();
  for (const range of ranges) {
    const datum = plutusData(bytes, range, 'datum');
    const hash = blake2b(datum, { dkLen: 32 });
    const hex = bytesToHex(hash);
    if (!byHash.has(hex)) byHash.set(hex, { hash, bytes: datum });
  }
  return [...byHash.values()];
}

// script_data_hash = hash32
function readScriptDataHash(value: CborValue | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array) || value.length !== 32) malformed('script data hash');
  return value;
}

// mint = {+ policy_id => {+ asset_name => nonzero_int64}}, already checked by the page parser.
function readMint(value: CborValue | undefined): MultiAsset {
  const mint: MultiAsset = new Map();
  if (value === undefined) return mint;
  if (!(value instanceof Map)) malformed('mint');
  for (const [policy, names] of value) {
    if (!(policy instanceof Uint8Array) || !(names instanceof Map)) malformed('mint');
    for (const [name, quantity] of names) {
      if (!(name instanceof Uint8Array) || typeof quantity !== 'bigint') malformed('mint');
      addAsset(mint, bytesToHex(policy), bytesToHex(name), quantity);
    }
  }
  return mint;
}

// reward_account: one header byte and the 28 byte credential hash. A node decodes the
// header only when it is 0xe0, 0xe1, 0xf0 or 0xf1 (Address.hs headerIsAccountAddress, the
// mask keeps the type bits and the two bits no account header may set, bits 4 and 0 are the
// credential kind and the network). Any other header never decodes.
function rewardAccount(value: CborValue | undefined, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 29) malformed(what);
  if ((value[0]! & 0b11101110) !== 0b11100000) malformed(what);
  return value;
}

// withdrawals = {+ reward_account => coin}
function readWithdrawals(value: CborValue | undefined): TxFacts['withdrawals'] {
  if (value === undefined) return [];
  if (!(value instanceof Map)) malformed('withdrawals');
  return [...value].map(([raw, amount]) => {
    const rewardAddress = rewardAccount(raw, 'withdrawal reward address');
    return { rewardAddress, credential: accountCredential(rewardAddress), amount: coin(amount, 'withdrawal amount') };
  });
}

// proposal_procedure = [deposit : coin, reward_account, gov_action, anchor], the page parser checked the length.
function readProposals(value: CborValue | undefined): TxFacts['proposals'] {
  return (value === undefined ? [] : unwrapSet(value)).map((p) => {
    if (!Array.isArray(p)) malformed('proposal procedure');
    return { deposit: coin(p[0], 'proposal deposit'), returnAccount: rewardAccount(p[1], 'proposal reward account') };
  });
}

// auxiliary_data_hash = hash32
function readAuxiliaryDataHash(value: CborValue | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array) || value.length !== 32) malformed('auxiliary data hash');
  return value;
}

// network_id = 0 / 1
function readNetworkId(value: CborValue | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (value !== 0n && value !== 1n) malformed('network id');
  return value;
}

// donation is positive_coin, 0 when absent
function readDonation(value: CborValue | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value !== 'bigint' || value <= 0n) malformed('treasury donation');
  return value;
}

// The CBOR head of an unsigned integer or a length: one byte up to 23, then 1, 2, 4 or 8 more.
function headSize(n: bigint): number {
  return n < 24n ? 1 : n < 0x100n ? 2 : n < 0x10000n ? 3 : n < 0x100000000n ? 5 : 9;
}

// A byte string from its hex, header included.
const bytesSize = (hex: string) => headSize(BigInt(hex.length / 2)) + hex.length / 2;

// Binary/Encoding/Encoder.hs variableMapLenEncoding: a definite header up to 23 entries, above
// that an indefinite header and a break byte.
const mapHeadSize = (entries: number) => (entries <= 23 ? 1 : 2);

/**
 * Bytes of a value as the ledger serializes it for maxValSize (Alonzo/Rules/Utxo.hs
 * validateOutputTooBigUTxO). Mary Value.hs: a bare coin without assets, otherwise
 * [coin, multiasset] with both map levels written by encodeMap.
 */
function valueSize(coin: bigint, assets: MultiAsset | undefined): number {
  if (!assets || assets.size === 0) return headSize(coin);
  let size = 1 + headSize(coin) + mapHeadSize(assets.size);
  for (const [policy, names] of assets) {
    size += bytesSize(policy) + mapHeadSize(names.size);
    for (const [name, quantity] of names) size += bytesSize(name) + headSize(quantity);
  }
  return size;
}

function sized(output: TxOutput, start: number, end: number): SizedOutput {
  return { output, size: end - start, valueSize: valueSize(output.lovelace, output.assets) };
}

/** Throws a plain Error on a field the page parser does not check (fee missing, malformed certificate or redeemer). */
export function readTransaction(bytes: Uint8Array, parsed: ParsedTransaction): TxFacts {
  // Alonzo Tx.hs sizeAlonzoTxF and toCBORForSizeComputation: body, witness set and auxiliary
  // data in their original bytes behind a one byte header for a list of three, never the
  // is_valid byte. The sum works for a definite and an indefinite top-level array alike.
  const { ranges: items } = arrayItemRanges(bytes, 0, false);
  if (items.length !== 4) throw new Error('not a transaction: expected a CBOR array of 4 items');
  const [bodyRange, witnessRange, , auxRange] = items as [[number, number], [number, number], [number, number], [number, number]];
  const span = ([start, end]: [number, number]) => BigInt(end - start);
  const size = 1n + span(bodyRange) + span(witnessRange) + span(auxRange);

  const body = decodeItem(bytes, bodyRange[0]).value;
  const witnessSet = decodeItem(bytes, witnessRange[0]).value;
  if (!(body instanceof Map) || !(witnessSet instanceof Map)) throw new Error('not a transaction: body and witness set must be maps');

  const fee = body.get(BODY_FEE);
  if (fee === undefined) throw new Error('transaction body has no fee');

  // Babbage TxOut.hs babbageMinUTxOValue counts the output in the bytes it arrived in.
  const offsets = mapValueOffsets(bytes, bodyRange[0]);
  const outputsAt = offsets.get(BODY_OUTPUTS);
  const outputRanges = outputsAt === undefined ? [] : arrayItemRanges(bytes, outputsAt, false).ranges;
  if (outputRanges.length !== parsed.body.outputs.length) throw new Error('outputs do not match the parsed transaction');
  const outputs = parsed.body.outputs.map((output, i) => sized(output, ...outputRanges[i]!));
  const returnAt = offsets.get(BODY_COLLATERAL_RETURN);
  const collateralReturn =
    parsed.body.collateralReturn === undefined || returnAt === undefined ? undefined : sized(parsed.body.collateralReturn, returnAt, decodeItem(bytes, returnAt).next);

  const rawCertificates = body.get(BODY_CERTIFICATES);
  const proposals = readProposals(body.get(BODY_PROPOSAL_PROCEDURES));
  const bootstrap = witnessSet.get(WITNESS_BOOTSTRAP);
  // Core.hs hashTxAuxData: Blake2b-256 over the auxiliary data in the bytes it arrived in.
  const auxIsNull = bytes[auxRange[0]] === CBOR_NULL;
  const witnessOffsets = mapValueOffsets(bytes, witnessRange[0]);
  const redeemers = readRedeemers(bytes, witnessOffsets.get(WITNESS_REDEEMERS));

  return {
    size,
    fee: coin(fee, 'fee'),
    outputs,
    collateralReturn,
    totalCollateral: optionalCoin(body.get(BODY_TOTAL_COLLATERAL), 'total collateral'),
    networkId: readNetworkId(body.get(BODY_NETWORK_ID)),
    withdrawals: readWithdrawals(body.get(BODY_WITHDRAWALS)),
    mint: readMint(body.get(BODY_MINT)),
    treasuryDonation: readDonation(body.get(BODY_DONATION)),
    currentTreasuryValue: optionalCoin(body.get(BODY_CURRENT_TREASURY), 'current treasury value'),
    certificates: (rawCertificates === undefined ? [] : unwrapSet(rawCertificates)).map(readCertificate),
    proposals,
    auxiliaryData: {
      declaredHash: readAuxiliaryDataHash(body.get(BODY_AUXILIARY_DATA_HASH)),
      computedHash: auxIsNull ? undefined : blake2b(bytes.subarray(...auxRange), { dkLen: 32 }),
    },
    redeemers: redeemers.map((r) => r.fact),
    redeemerData: redeemers.map(({ fact, data }) => ({ tag: fact.tag, index: fact.index, data })),
    redeemersBytes: itemBytes(bytes, witnessOffsets.get(WITNESS_REDEEMERS)),
    plutusScripts: readPlutusScripts(bytes, witnessOffsets),
    datums: readDatums(bytes, witnessOffsets.get(WITNESS_DATUMS)),
    datumsBytes: itemBytes(bytes, witnessOffsets.get(WITNESS_DATUMS)),
    scriptDataHash: readScriptDataHash(body.get(BODY_SCRIPT_DATA_HASH)),
    // bootstrap_witness = [public_key, signature, chain_code, attributes]
    bootstrapWitnesses: (bootstrap === undefined ? [] : unwrapSet(bootstrap)).length,
  };
}
