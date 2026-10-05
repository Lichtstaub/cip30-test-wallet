import { blake2b } from '@noble/hashes/blake2.js';
import { concat } from '../../core/bytes.js';
import { encode } from '../../core/cbor/encode.js';
import type { CostModels } from '../cost-models.js';
import type { CheckContext } from './context.js';
import type { PlutusNeed } from './plutus-purposes.js';

// The script integrity hash, body key 11 (script_data_hash): Alonzo Tx.hs
// mkScriptIntegrity and hashScriptIntegrity, the language views of Alonzo
// PParams.hs getLanguageView and encodeLangViews.

// Redeemers mempty under Conway's lowest protocol version (Alonzo TxWits.hs, the map form from version 9).
const EMPTY_REDEEMERS = Uint8Array.of(0xa0);
const CBOR_NULL = Uint8Array.of(0xf6);

/** An empty cost model array counts as absent, the ledger then encodes the view's value as null. */
function costModel(costModels: CostModels, language: 1 | 2 | 3): bigint[] | undefined {
  const model = costModels[`PlutusV${language}`];
  return model.length === 0 ? undefined : model;
}

/** One language view as [key bytes, value bytes]. */
function languageView(language: 1 | 2 | 3, costModels: CostModels): [Uint8Array, Uint8Array] {
  const model = costModel(costModels, language);
  if (language === 1) {
    // PlutusV1 keeps a past bug: the key is the language tag serialized twice (41 00), the
    // value a byte string around the cost model as an indefinite list (encodeCostModel), or
    // around null when the model is absent.
    const params = model === undefined ? CBOR_NULL : concat(Uint8Array.of(0x9f), ...model.map((n) => encode(n)), Uint8Array.of(0xff));
    return [encode(encode(0n)), encode(params)];
  }
  // PlutusV2 and V3: the language tag (1, 2) and the cost model as a definite list, null when absent.
  return [encode(BigInt(language - 1)), model === undefined ? CBOR_NULL : encode(model)];
}

// encodeLangViews sorts by the key bytes in shortLex order, shorter first, which puts V2 and V3 before V1.
function shortLex(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** The language views of the given languages, a definite CBOR map in the order encodeLangViews writes it. */
export function languageViews(languages: ReadonlySet<1 | 2 | 3>, costModels: CostModels): Uint8Array {
  const views = [...languages].map((language) => languageView(language, costModels)).sort(([a], [b]) => shortLex(a, b));
  // A map of at most three entries: header 0xa0 plus the count.
  return concat(Uint8Array.of(0xa0 + views.length), ...views.flat());
}

/**
 * The script_data_hash a node expects, undefined when the field must be absent.
 *
 * mkScriptIntegrity: absent when the transaction has no redeemers, no
 * datums and no needed Plutus script. Otherwise Blake2b-256 over the
 * redeemers in their original bytes (a0 when the field is absent), the
 * datums in their original bytes (nothing when there are none) and the
 * language views of every language a needed and provided Plutus script uses.
 */
export function expectedScriptDataHash(ctx: CheckContext, needs: readonly PlutusNeed[]): Uint8Array | undefined {
  const { redeemers, redeemersBytes, datums, datumsBytes } = ctx.facts;
  const languages = new Set(needs.map((n) => n.language));
  if (redeemers.length === 0 && datums.length === 0 && languages.size === 0) return undefined;
  const datumPart = datums.length === 0 || datumsBytes === undefined ? new Uint8Array(0) : datumsBytes;
  return blake2b(concat(redeemersBytes ?? EMPTY_REDEEMERS, datumPart, languageViews(languages, ctx.params.costModels)), { dkLen: 32 });
}
