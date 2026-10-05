import { bytesEqual, bytesToHex } from '../../core/bytes.js';
import type { TxInput } from '../../core/cbor/tx.js';
import { certificateName } from '../../core/requirements.js';
import { knownInputs, type CheckContext } from './context.js';
import { coin, failer, list, mismatch, PATH, type Failure } from './failure.js';
import type { PlutusNeed } from './plutus-purposes.js';
import { expectedScriptDataHash } from './script-integrity.js';

// The Plutus part of UTXOW (Babbage Rules/Utxow.hs babbageUtxowTransition with
// the validators of Alonzo Rules/Utxow.hs) and the collect phase of UTXOS
// (Alonzo Plutus/Evaluate.hs scriptsWithContextFromLedgerTxInfoWithResult).
// Details are readable and follow the node's argument order without copying
// Haskell Show. A redeemer pointer is written as 'ConwaySpending (AsIx 0)'
// everywhere, where MissingRedeemers and NoRedeemer in the node show the item
// (the TxIn, the policy id, the certificate) instead of its index.

// Conway Scripts.hs ConwayPlutusPurpose in tag order, the published names (see plutus-purposes.ts).
const PURPOSES = ['ConwaySpending', 'ConwayMinting', 'ConwayCertifying', 'ConwayRewarding', 'ConwayVoting', 'ConwayProposing'];

const outpoint = (input: TxInput) => `${bytesToHex(input.txId)}#${input.index}`;
const compareInputs = (a: TxInput, b: TxInput) => {
  const [x, y] = [bytesToHex(a.txId), bytesToHex(b.txId)];
  return x < y ? -1 : x > y ? 1 : a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
};
/** Hex hashes in Set order, which for hashes of one length is byte order. */
const sortedHashes = (hashes: Iterable<string>) => [...new Set(hashes)].sort();
const redeemerKey = (tag: bigint, index: bigint) => `${tag}:${index}`;
/** 'x :| [y, z]', as Show writes a NonEmpty. */
const nonEmpty = (items: readonly string[]) => `${items[0]} :| ${list(items.slice(1))}`;

/** UTXOW: UnspendableUTxONoDatumHash, MissingRequiredDatums, NotAllowedSupplementalDatums. witnessFailures runs it after the script presence checks. */
export function datumFailures(ctx: CheckContext, needs: readonly PlutusNeed[]): Failure[] {
  const { facts } = ctx;
  const failures: Failure[] = [];
  const fail = failer(PATH.UTXOW, failures);

  // Alonzo Rules/Utxow.hs missingRequiredDatums with Alonzo UTxO.hs getInputDataHashesTxBody: every
  // spend input at a provided Plutus script, which are exactly the spend needs. A datum hash must
  // have its datum in the witness set. No datum at all is allowed from PlutusV3 on (CIP-69).
  const inputHashes = new Set<string>();
  const unspendable: TxInput[] = [];
  for (const need of needs) {
    if (!need.spend) continue;
    const { datum } = need.spend.utxo;
    if (datum === undefined && need.language < 3) unspendable.push(need.spend.input);
    else if (datum?.kind === 'hash') inputHashes.add(bytesToHex(datum.hash));
  }
  const received = new Set(facts.datums.map((d) => bytesToHex(d.hash)));
  // Babbage UTxO.hs getBabbageSupplementalDataHashes: datum hashes of every new output, the
  // collateral return included, and of the UTxOs of the reference inputs. Inline datums never.
  const outputs = [...facts.outputs.map((o) => o.output), ...(facts.collateralReturn ? [facts.collateralReturn.output] : [])];
  const references = knownInputs(ctx).flatMap(({ label, utxo }) => (label === 'reference input' && utxo ? [utxo] : []));
  const allowed = new Set([...outputs, ...references].flatMap((o) => (o.datum?.kind === 'hash' ? [bytesToHex(o.datum.hash)] : [])));
  const unmatched = sortedHashes([...inputHashes].filter((h) => !received.has(h)));
  const supplemental = [...received].filter((h) => !inputHashes.has(h));
  const notAllowed = sortedHashes(supplemental.filter((h) => !allowed.has(h)));
  const acceptable = sortedHashes(supplemental.filter((h) => allowed.has(h)));
  if (unspendable.length > 0) fail('UnspendableUTxONoDatumHash', list(unspendable.sort(compareInputs).map(outpoint)));
  if (unmatched.length > 0) fail('MissingRequiredDatums', `{missing: ${list(unmatched)}, received: ${list(sortedHashes(received))}}`);
  if (notAllowed.length > 0) fail('NotAllowedSupplementalDatums', `{unallowed: ${list(notAllowed)}, acceptable: ${list(acceptable)}}`);
  return failures;
}

/** UTXOW: ExtraRedeemers, then MissingRedeemers. witnessFailures runs it right after datumFailures, before the VKey checks. */
export function redeemerFailures(ctx: CheckContext, needs: readonly PlutusNeed[]): Failure[] {
  const { facts } = ctx;
  const failures: Failure[] = [];
  const fail = failer(PATH.UTXOW, failures);

  // Alonzo Rules/Utxow.hs hasExactSetOfRedeemers: ExtraRedeemers in the order of the redeemer
  // map keys (tag, then index), MissingRedeemers in the order of the needs.
  const needed = new Set(needs.map((n) => redeemerKey(n.tag, n.index)));
  const present = new Set(facts.redeemers.map((r) => redeemerKey(r.tag, r.index)));
  const extra = [...facts.redeemers]
    .filter((r) => !needed.has(redeemerKey(r.tag, r.index)))
    .sort((a, b) => (a.tag !== b.tag ? (a.tag < b.tag ? -1 : 1) : a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
    .map((r) => `${PURPOSES[Number(r.tag)]} (AsIx ${r.index})`);
  const missing = needs.filter((n) => !present.has(redeemerKey(n.tag, n.index))).map((n) => `(${n.purpose}, ${bytesToHex(n.scriptHash)})`);
  if (extra.length > 0) fail('ExtraRedeemers', list(extra));
  if (missing.length > 0) fail('MissingRedeemers', list(missing));
  return failures;
}

/**
 * UTXOW: ScriptIntegrityHashMismatch. witnessFailures runs it after the metadata checks.
 *
 * Alonzo Rules/Utxow.hs checkScriptIntegrityHash, from protocol 11 ScriptIntegrityHashMismatch.
 * Present against absent fails as well. The node's second field, the expected preimage, is left
 * out: with a PlutusV3 cost model it runs to well over a kilobyte.
 */
export function scriptIntegrityFailures(ctx: CheckContext, needs: readonly PlutusNeed[]): Failure[] {
  const expected = expectedScriptDataHash(ctx, needs);
  const supplied = ctx.facts.scriptDataHash;
  const same = expected === undefined || supplied === undefined ? expected === supplied : bytesEqual(expected, supplied);
  const show = (hash: Uint8Array | undefined) => (hash === undefined ? 'SNothing' : `SJust ${bytesToHex(hash)}`);
  return same ? [] : [{ path: PATH.UTXOW, rule: 'ScriptIntegrityHashMismatch', detail: mismatch('RelEQ', show(supplied), show(expected)) }];
}

// Conway TxInfo.hs transTxCertV1V2 with Alonzo TxInfo.hs transTxCertCommon: the certificates a PlutusV1
// or V2 context can show, 0 and 1 (no deposit), 2 (stake delegation), 3 and 4 (pool), 7 and 8 (deposit).
const V1_V2_CERTIFICATES = new Set<bigint>([0n, 1n, 2n, 3n, 4n, 7n, 8n]);
// Voter types of the Conway CDDL, 0 and 1 committee, 2 and 3 DRep, 4 pool, by constructor name.
const VOTERS = ['CommitteeVoter', 'CommitteeVoter', 'DRepVoter', 'DRepVoter', 'StakePoolVoter'];
// Governance actions of the Conway CDDL in tag order.
const GOV_ACTIONS = ['ParameterChange', 'HardForkInitiation', 'TreasuryWithdrawals', 'NoConfidence', 'UpdateCommittee', 'NewConstitution', 'InfoAction'];

/**
 * The first ContextError the node meets while it builds the TxInfo of one Plutus language (Conway TxInfo.hs
 * toPlutusTxInfo of each EraPlutusTxInfo instance), undefined when the TxInfo can be built. Unchecked, see the
 * README: a context input missing from the UTxO set (TranslationLogicMissingInput, BadInputsUTxO comes first
 * anyway), a redeemer that points to nothing (RedeemerPointerPointsToNothing, ExtraRedeemers comes first anyway),
 * a reference input at a Byron address and the time horizon.
 */
function txInfoError(ctx: CheckContext, language: 1 | 2 | 3): string | undefined {
  const { parsed, facts } = ctx;
  const { body } = parsed;
  if (language === 3) {
    // checkReferenceInputsNotDisjointFromInputs, part of the PlutusV3 TxInfo from protocol 11 on: spend and
    // reference inputs must not share a TxIn, the shared ones in Set order.
    if (ctx.params.protocolMajorVersion < 11n) return undefined;
    const spend = new Set(body.inputs.map(outpoint));
    const shared = new Map(body.referenceInputs.filter((i) => spend.has(outpoint(i))).map((i) => [outpoint(i), i]));
    if (shared.size === 0) return undefined;
    return `ReferenceInputsNotDisjointFromInputs (${nonEmpty([...shared.values()].sort(compareInputs).map(outpoint))})`;
  }

  // guardConwayFeaturesForPlutusV1V2 comes first for PlutusV1 and V2.
  if (body.voters.length > 0) return `VotingProceduresFieldNotSupported ${list(body.voters.map((v) => `${VOTERS[Number(v.type)]} ${bytesToHex(v.hash)}`))}`;
  if (body.proposals.length > 0) return `ProposalProceduresFieldNotSupported ${list(body.proposals.map((p) => GOV_ACTIONS[Number(p.actionIndex)] ?? `action ${p.actionIndex}`))}`;
  if (facts.treasuryDonation !== 0n) return `TreasuryDonationFieldNotSupported (${coin(facts.treasuryDonation)})`;
  if (facts.currentTreasuryValue !== undefined) return `CurrentTreasuryFieldNotSupported (${coin(facts.currentTreasuryValue)})`;

  if (language === 1) {
    // Conway transTxOutV1: no inline datum in a spend input, then a reference input, each in Set order, then an
    // output by position. The collateral return is no part of the TxInfo. An input the UTxO set does not know
    // is skipped here, the node stops at it with TranslationLogicMissingInput.
    for (const label of ['input', 'reference input'] as const) {
      const inline = knownInputs(ctx).filter((k) => k.label === label && k.utxo?.datum?.kind === 'inline').map((k) => k.input);
      if (inline.length > 0) return `BabbageContextError (InlineDatumsNotSupported (TxOutFromInput ${outpoint(inline.sort(compareInputs)[0]!)}))`;
    }
    const output = facts.outputs.findIndex((o) => o.output.datum?.kind === 'inline');
    if (output >= 0) return `BabbageContextError (InlineDatumsNotSupported (TxOutFromOutput (TxIx ${output})))`;
  }

  // Alonzo transTxBodyCerts, every certificate in body order.
  const cert = facts.certificates.find((c) => !V1_V2_CERTIFICATES.has(c.cert));
  return cert ? `CertificateNotSupported (${certificateName(cert.cert)})` : undefined;
}

/**
 * The translation of one script's context: the TxInfo of its language, then its purpose (Alonzo TxInfo.hs
 * mkPlutusWithContext). Alonzo transPlutusPurpose has no PlutusV1 or V2 purpose for a vote or a proposal. In
 * Conway the guard of the TxInfo refuses both fields first, so this only keeps the node's order.
 */
function translationError(ctx: CheckContext, need: PlutusNeed): string | undefined {
  const txInfo = txInfoError(ctx, need.language);
  if (txInfo !== undefined) return txInfo;
  return need.language < 3 && need.tag >= 4n ? `PlutusPurposeNotSupported (${need.purpose})` : undefined;
}

/**
 * UTXOS collect phase: NoRedeemer and the translation of every needed script's context, merged in the node's
 * reporting order. Always reported.
 *
 * Alonzo Plutus/Evaluate.hs scriptsWithContextFromLedgerTxInfoWithResult walks
 * the needs in order and merges: a script without a redeemer is a
 * NoRedeemer, consed to the front of the errors so far. A script with a
 * redeemer is checked for its translation only while no error has been
 * found, the first such failure starts the list. So the list comes out in
 * reverse order, and a translation failure after the first error is never
 * seen. NoCostModel cannot happen here: every language has a default cost
 * model, and an override replaces it with a non-empty one. CollectErrors
 * holds a NonEmpty.
 */
export function collectFailures(ctx: CheckContext, needs: readonly PlutusNeed[]): Failure[] {
  const present = new Set(ctx.facts.redeemers.map((r) => redeemerKey(r.tag, r.index)));
  let errors: string[] | undefined;
  for (const need of needs) {
    if (!present.has(redeemerKey(need.tag, need.index))) {
      errors = [`NoRedeemer (${need.purpose})`, ...(errors ?? [])];
      continue;
    }
    if (errors) continue;
    const error = translationError(ctx, need);
    if (error !== undefined) errors = [`BadTranslation (${error})`];
  }
  return errors ? [{ path: PATH.UTXOS, rule: 'CollectErrors', detail: nonEmpty(errors) }] : [];
}
