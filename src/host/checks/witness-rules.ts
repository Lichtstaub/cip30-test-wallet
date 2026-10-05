import { bytesEqual, bytesToHex } from '../../core/bytes.js';
import { keyHash, verifiesOver } from '../../core/keys.js';
import type { Requirements } from '../../core/requirements.js';
import { evaluateNativeScript, scriptsProvided } from '../../core/scripts.js';
import { knownInputs, type CheckContext } from './context.js';
import { failer, list, mismatch, PATH, type Failure } from './failure.js';
import type { PlutusNeed } from './plutus-purposes.js';
import { datumFailures, redeemerFailures, scriptIntegrityFailures } from './plutus-rules.js';

// The witness part of the UTXOW rule of a Conway node: Babbage/Rules/Utxow.hs
// babbageUtxowTransition with validators from Shelley/Rules/Utxow.hs. Plutus
// scripts count for presence here. The datum, redeemer and script integrity
// rules of plutus-rules.ts run where the node runs them, the scripts
// themselves run in phase-two.ts.

/** Hex hashes in first-seen order, each once. */
function hashSet(scripts: ReadonlyArray<{ hash: Uint8Array }>): Set<string> {
  return new Set(scripts.map((s) => bytesToHex(s.hash)));
}

/**
 * UTXOW in node order: script presence, datums, redeemers, vkey witnesses, metadata, the script
 * integrity hash. reqs from requirements(body, resolved spent inputs), needs from plutusNeeds.
 */
export function witnessFailures(ctx: CheckContext, reqs: Requirements, needs: readonly PlutusNeed[]): Failure[] {
  const { parsed } = ctx;
  const { body } = parsed;
  const failures: Failure[] = [];
  const fail = failer(PATH.UTXOW, failures);

  // Core.hs keyHashWitnessesTxWits: the key hash of every vkey witness, valid or not. A bad
  // signature is reported once, as InvalidWitnessesUTXOW, and still counts as present.
  const witnessKeys = parsed.vkeyWitnesses.filter((w) => w.vkey.length === 32).map((w) => keyHash(w.vkey));
  const witnessKeySet = new Set(witnessKeys.map(bytesToHex));

  // Babbage getBabbageScriptsProvided: witness set, then the reference scripts of spend and reference inputs.
  const sources = knownInputs(ctx).flatMap(({ label, utxo }) => (utxo ? [{ label, utxo }] : []));
  const provided = scriptsProvided(parsed.scripts, sources).scripts;
  // scriptsProvided appends the reference scripts after the witness scripts.
  const referenced = hashSet(provided.slice(parsed.scripts.length));
  const received = hashSet(parsed.scripts);
  const needed = new Set(reqs.scripts.map((s) => bytesToHex(s.scriptHash)));

  // Babbage/Rules/Utxow.hs validateFailedBabbageScripts: needed native scripts evaluated with the
  // witness key hashes and the validity interval of the transaction, never the current slot.
  const failing = new Set<string>();
  for (const script of provided) {
    const hex = bytesToHex(script.hash);
    if (script.native && needed.has(hex) && !evaluateNativeScript(script.native, witnessKeys, body.validityStart, body.ttl)) failing.add(hex);
  }
  if (failing.size > 0) fail('ScriptWitnessNotValidatingUTXOW', list(failing));

  // Babbage/Rules/Utxow.hs babbageMissingScripts: needed minus reference scripts must equal the witness scripts.
  const neededNonRefs = new Set([...needed].filter((hex) => !referenced.has(hex)));
  const extraneous = [...received].filter((hex) => !neededNonRefs.has(hex));
  if (extraneous.length > 0) fail('ExtraneousScriptWitnessesUTXOW', list(extraneous));
  const missing = [...neededNonRefs].filter((hex) => !received.has(hex));
  if (missing.length > 0) fail('MissingScriptWitnessesUTXOW', list(missing));

  // babbageUtxowTransition checks the datums (missingRequiredDatums) and the redeemers
  // (hasExactSetOfRedeemers) right after the scripts, before the key witnesses.
  failures.push(...datumFailures(ctx, needs), ...redeemerFailures(ctx, needs));

  // Shelley/Rules/Utxow.hs validateVerifiedWits: every vkey witness verifies over the body hash.
  const invalid = parsed.vkeyWitnesses.filter((w) => !verifiesOver(w, parsed.hash)).map((w) => bytesToHex(w.vkey));
  if (invalid.length > 0) fail('InvalidWitnessesUTXOW', list(invalid));

  // Shelley/Rules/Utxow.hs validateNeededWitnesses with Conway/UTxO.hs getConwayWitsVKeyNeeded:
  // pool and committee keys the wallet never signs count as well.
  const missingKeys = new Set(reqs.keys.map((k) => bytesToHex(k.keyHash)).filter((hex) => !witnessKeySet.has(hex)));
  if (missingKeys.size > 0) fail('MissingVKeyWitnessesUTXOW', list(missingKeys));

  // Shelley/Rules/Utxow.hs validateMetadata, which babbageUtxowTransition runs right after the
  // needed witnesses. InvalidMetadata, in Conway a Plutus script in the auxiliary data that does
  // not deserialize, is not checked.
  const { declaredHash, computedHash } = ctx.facts.auxiliaryData;
  if (computedHash && !declaredHash) fail('MissingTxBodyMetadataHash', bytesToHex(computedHash));
  else if (declaredHash && !computedHash) fail('MissingTxMetadata', bytesToHex(declaredHash));
  else if (declaredHash && computedHash && !bytesEqual(declaredHash, computedHash)) {
    fail('ConflictingMetadataHash', mismatch('RelEQ', bytesToHex(declaredHash), bytesToHex(computedHash)));
  }

  // Alonzo/Rules/Utxow.hs checkScriptIntegrityHash, the last check of UTXOW before UTXO.
  failures.push(...scriptIntegrityFailures(ctx, needs));

  return failures;
}
