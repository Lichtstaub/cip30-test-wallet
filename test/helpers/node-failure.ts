// Reads the first ledger failure out of a node or wallet rejection text. Kept free of devnet imports,
// so the parser test runs with the unit suite.

// The rule wrappers of Conway's LEDGER, UTXOW, UTXO, UTXOS, CERTS and GOV rules. Every other name is a rule.
const WRAPPERS = new Set(['ConwayUtxowFailure', 'UtxoFailure', 'UtxosFailure', 'ConwayCertsFailure', 'CertFailure', 'DelegFailure', 'PoolFailure', 'GovCertFailure', 'ConwayGovFailure']);

/**
 * The wrappers and the rule name of the first failure in a ConwayApplyTxError, the way the node
 * prints it ('ConwayApplyTxError (x :| [..])') and the way the wallet's info writes it
 * ('ConwayApplyTxError [x, ..]'). For example ['ConwayUtxowFailure', 'UtxoFailure', 'BadInputsUTxO'].
 */
export function headFailure(text: string): string[] {
  const start = /ConwayApplyTxError [([]/.exec(text);
  if (!start) throw new Error(`no ConwayApplyTxError in: ${text.slice(0, 500)}`);
  const word = /\s*\(?\s*([A-Za-z][A-Za-z0-9]*)/y;
  word.lastIndex = start.index + start[0].length;
  const names: string[] = [];
  for (let match = word.exec(text); match; match = word.exec(text)) {
    names.push(match[1]!);
    if (!WRAPPERS.has(match[1]!)) break;
  }
  return names;
}
