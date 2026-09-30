import { blake2b } from '@noble/hashes/blake2.js';
import { bytesEqual, bytesToHex } from './bytes.js';
import { arrayItemRanges, decode, type CborValue } from './cbor/decode.js';
import type { Utxo } from './ledger.js';
import { MAX_INT64, MIN_INT64 } from './value.js';

// Scripts after the Conway CDDL (script_hash, native_script, script) and
// cardano-ledger, evalTimelock in Allegra/Scripts.hs for native scripts.
// The ledger keeps a native script in the bytes it arrived in (MemoBytes)
// and hashes those, so nothing here ever re-encodes a script.

/** The tag the ledger prepends before hashing: 0 native, 1 to 3 Plutus V1 to V3. */
export type ScriptLanguage = 0 | 1 | 2 | 3;

export type NativeScript =
  | { type: 'pubkey'; keyHash: Uint8Array }
  | { type: 'all'; scripts: NativeScript[] }
  | { type: 'any'; scripts: NativeScript[] }
  | { type: 'nOfK'; n: bigint; scripts: NativeScript[] }
  | { type: 'invalidBefore'; slot: bigint }
  | { type: 'invalidHereafter'; slot: bigint };

/** A script a transaction provides, from its witness set or from a reference script. */
export interface ProvidedScript {
  hash: Uint8Array;
  language: ScriptLanguage;
  /** The parsed expression, only for language 0. */
  native?: NativeScript;
}

// The same bound isNativeScript in host/cbor-shapes.ts used before M6.
const MAX_DEPTH = 256;

export function scriptHash(language: ScriptLanguage, bytes: Uint8Array): Uint8Array {
  const tagged = new Uint8Array(bytes.length + 1);
  tagged[0] = language;
  tagged.set(bytes, 1);
  return blake2b(tagged, { dkLen: 28 });
}

function malformed(): never {
  throw new Error('malformed native script');
}

function slot(value: CborValue | undefined): bigint {
  if (typeof value !== 'bigint' || value < 0n) malformed();
  return value;
}

/**
 * native_script = [0, addr_keyhash] / [1, [* native_script]] / [2, [* native_script]]
 *   / [3, int64, [* native_script]] / [4, slot] / [5, slot]
 * Throws a plain Error on any other shape, callers turn it into their own error.
 */
export function parseNativeScript(value: CborValue, depth = 0): NativeScript {
  if (depth > MAX_DEPTH) throw new Error('native script nested too deep');
  if (!Array.isArray(value) || typeof value[0] !== 'bigint') malformed();
  const list = (items: CborValue | undefined): NativeScript[] => {
    if (!Array.isArray(items)) malformed();
    return items.map((item) => parseNativeScript(item, depth + 1));
  };
  switch (value[0]) {
    case 0n: {
      const hash = value[1];
      if (value.length !== 2 || !(hash instanceof Uint8Array) || hash.length !== 28) malformed();
      return { type: 'pubkey', keyHash: hash };
    }
    case 1n:
    case 2n:
      if (value.length !== 2) malformed();
      return { type: value[0] === 1n ? 'all' : 'any', scripts: list(value[1]) };
    case 3n: {
      const n = value[1];
      if (value.length !== 3 || typeof n !== 'bigint' || n < MIN_INT64 || n > MAX_INT64) malformed();
      return { type: 'nOfK', n, scripts: list(value[2]) };
    }
    case 4n:
    case 5n:
      if (value.length !== 2) malformed();
      return { type: value[0] === 4n ? 'invalidBefore' : 'invalidHereafter', slot: slot(value[1]) };
    default:
      return malformed();
  }
}

/** Every key hash a pubkey leaf names, at any depth, in script order. */
export function nativeKeyHashes(script: NativeScript): Uint8Array[] {
  switch (script.type) {
    case 'pubkey':
      return [script.keyHash];
    case 'all':
    case 'any':
    case 'nOfK':
      return script.scripts.flatMap(nativeKeyHashes);
    default:
      return [];
  }
}

/**
 * evalTimelock: a pubkey holds when its hash is among the witness key
 * hashes, invalid_before n when the validity start is at least n,
 * invalid_hereafter n when the ttl is at most n. A missing validity start
 * or ttl fails the timelock. n_of_k holds as soon as n <= 0.
 */
export function evaluateNativeScript(
  script: NativeScript,
  witnessKeyHashes: ReadonlyArray<Uint8Array>,
  validityStart: bigint | undefined,
  ttl: bigint | undefined,
): boolean {
  const holds = (s: NativeScript): boolean => {
    switch (s.type) {
      case 'pubkey':
        return witnessKeyHashes.some((h) => bytesEqual(h, s.keyHash));
      case 'all':
        return s.scripts.every(holds);
      case 'any':
        return s.scripts.some(holds);
      case 'nOfK':
        return BigInt(s.scripts.filter(holds).length) >= s.n;
      case 'invalidBefore':
        return validityStart !== undefined && s.slot <= validityStart;
      case 'invalidHereafter':
        return ttl !== undefined && ttl <= s.slot;
    }
  };
  return holds(script);
}

/**
 * One script as it stands in a witness set entry or a script reference: the
 * native script CBOR, or the CBOR byte string around a Plutus script. A native
 * script is hashed over exactly these bytes, a Plutus script over the content
 * of the byte string.
 */
export function providedScript(language: ScriptLanguage, item: Uint8Array): ProvidedScript {
  const value = decode(item);
  if (language === 0) return { hash: scriptHash(0, item), language, native: parseNativeScript(value) };
  if (!(value instanceof Uint8Array) || value.length === 0) throw new Error(`malformed Plutus V${language} script`);
  return { hash: scriptHash(language, value), language };
}

/** script = [0, native_script] / [1 to 3, plutus script bytes], the inner bytes of a script_ref. Throws a plain Error on any other shape. */
export function scriptFromRef(ref: Uint8Array): ProvidedScript {
  const { ranges, next } = arrayItemRanges(ref, 0, false);
  if (next !== ref.length || ranges.length !== 2) throw new Error('malformed script reference');
  const [[languageStart, languageEnd], [scriptStart, scriptEnd]] = ranges as [[number, number], [number, number]];
  const language = decode(ref.slice(languageStart, languageEnd));
  if (language !== 0n && language !== 1n && language !== 2n && language !== 3n) throw new Error('unknown script language in script reference');
  return providedScript(Number(language) as ScriptLanguage, ref.slice(scriptStart, scriptEnd));
}

/**
 * The scripts the ledger finds for a transaction: the witness set, then the
 * reference scripts of body inputs and reference inputs. Collateral inputs
 * are no source (Babbage getBabbageScriptsProvided). A script reference that
 * does not parse provides nothing and is named in unreadable, as
 * "input <id>#<index>" or "reference input <id>#<index>": fixture configuration
 * is checked in Node, only a hand-written PageConfig can carry one.
 * The offline ledger of M7 resolves scripts through this same function.
 */
export function scriptsProvided(
  witnessScripts: ReadonlyArray<ProvidedScript>,
  bodyInputs: ReadonlyArray<Utxo>,
  references: ReadonlyArray<Utxo>,
): { scripts: ProvidedScript[]; unreadable: string[] } {
  const scripts = [...witnessScripts];
  const unreadable: string[] = [];
  const sources: Array<[string, Utxo]> = [...bodyInputs.map((u): [string, Utxo] => ['input', u]), ...references.map((u): [string, Utxo] => ['reference input', u])];
  for (const [label, utxo] of sources) {
    if (!utxo.scriptRef) continue;
    try {
      scripts.push(scriptFromRef(utxo.scriptRef));
    } catch {
      unreadable.push(`${label} ${bytesToHex(utxo.input.txId)}#${utxo.input.index}`);
    }
  }
  return { scripts, unreadable };
}
