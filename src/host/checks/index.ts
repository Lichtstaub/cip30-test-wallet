import { isByronAddress } from '../../core/addresses.js';
import { requirements } from '../../core/requirements.js';
import type { CheckContext } from './context.js';
import { certificateFailures } from './cert-state.js';
import { mismatch, PATH, type Failure } from './failure.js';
import { plutusNeeds, type PlutusNeed } from './plutus-purposes.js';
import { collectFailures } from './plutus-rules.js';
import { refScriptsSize, utxoFailures } from './utxo-rules.js';
import { witnessFailures } from './witness-rules.js';

/** Conway/PParams.hs ppMaxRefScriptSizePerTxG: 200 KiB of reference scripts per transaction. */
export const MAX_REF_SCRIPT_SIZE_PER_TX = 204_800n;

// Conway/Rules/Mempool.hs mempoolTransition, the text a node reports.
const ALL_INPUTS_SPENT = 'All inputs are spent. Transaction has probably already been included';

/**
 * Every check of phase 1 and the collect step of phase 2 in node order. unsupported non-empty means
 * CHW_UNSUPPORTED_TX_FORM, failures and needs are then empty. needs are the Plutus scripts the
 * transaction runs, which CheckedLedger evaluates when nothing else failed.
 *
 * Conway/Rules/Mempool.hs first: when no spend input is unspent the node
 * reports only ConwayMempoolFailure and runs nothing else. Then the forms the
 * checks cannot judge. Then Conway/Rules/Ledger.hs: with is_valid the
 * reference script limit, CERTS and GOV, then UTXOW, which runs UTXO last.
 * witnessFailures keeps the UTXOW order of Babbage/Rules/Utxow.hs
 * babbageUtxowTransition, the Plutus rules included. UTXO ends in UTXOS,
 * whose CollectErrors a node reports next to every other failure
 * (Babbage/Rules/Utxos.hs expectScriptsToPass).
 * requirements() throws apiError InvalidRequest for a malformed certificate,
 * which passes through. On a submit the reader refuses such a certificate
 * first. A wrong field count or a malformed credential reads the same on both
 * paths, the reader also refuses fields requirements() does not check.
 */
export function checkTransaction(ctx: CheckContext): { failures: Failure[]; unsupported: string[]; needs: PlutusNeed[] } {
  const { parsed, facts } = ctx;
  const { body } = parsed;
  const inputCount = body.inputs.length;

  if (!ctx.resolved.slice(0, inputCount).some((u) => u !== undefined)) {
    return { failures: [{ path: PATH.LEDGER, rule: 'ConwayMempoolFailure', detail: `"${ALL_INPUTS_SPENT}"` }], unsupported: [], needs: [] };
  }

  // requirements reads the spent inputs only, body inputs then collateral inputs.
  const reqs = requirements(body, ctx.resolved.slice(0, inputCount + body.collateralInputs.length));
  const unsupported = [...reqs.unsupported];
  // The network of a Byron address sits in its attributes, which the checks do not read.
  if (facts.outputs.some((o) => isByronAddress(o.output.address))) unsupported.push('an output at a Byron address');
  if (facts.collateralReturn && isByronAddress(facts.collateralReturn.output.address)) unsupported.push('a collateral return at a Byron address');
  if (facts.bootstrapWitnesses > 0) unsupported.push('bootstrap witnesses');
  for (const cert of facts.certificates) if (cert.kind === 'deprecated') unsupported.push(`certificate ${cert.cert}, deprecated since Conway`);
  if (unsupported.length > 0) return { failures: [], unsupported: [...new Set(unsupported)], needs: [] };

  const failures: Failure[] = [];
  if (parsed.isValid) {
    // Conway/Rules/Ledger.hs validateRefScriptSize.
    const size = refScriptsSize(ctx);
    if (size > MAX_REF_SCRIPT_SIZE_PER_TX) {
      failures.push({ path: PATH.LEDGER, rule: 'ConwayTxRefScriptsSizeTooBig', detail: mismatch('RelLTEQ', `${size}`, `${MAX_REF_SCRIPT_SIZE_PER_TX}`) });
    }
    failures.push(...certificateFailures(facts, ctx.certState, ctx.params, ctx.networkId));
  }
  const needs = plutusNeeds(ctx);
  failures.push(...witnessFailures(ctx, reqs, needs), ...utxoFailures(ctx), ...collectFailures(ctx, needs));
  return { failures, unsupported: [], needs };
}
