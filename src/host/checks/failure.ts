// Rule failures in the shape a Conway node reports them on submit:
// ConwayApplyTxError with a list of ConwayLedgerPredFailure (Conway.hs), each one
// wrapped in the constructors of the rules it passed through (Rules/Ledger.hs,
// Rules/Utxow.hs, Rules/Certs.hs, Rules/Cert.hs). The details are readable, they
// do not reproduce Haskell Show exactly. A dApp should look at the rule name.

export interface Failure {
  path: readonly string[];
  rule: string;
  detail?: string;
}

export const PATH = {
  UTXO: ['ConwayUtxowFailure', 'UtxoFailure'],
  UTXOW: ['ConwayUtxowFailure'],
  DELEG: ['ConwayCertsFailure', 'CertFailure', 'DelegFailure'],
  POOL: ['ConwayCertsFailure', 'CertFailure', 'PoolFailure'],
  GOVCERT: ['ConwayCertsFailure', 'CertFailure', 'GovCertFailure'],
  GOV: ['ConwayGovFailure'],
  LEDGER: [],
} as const;

/** 'Mismatch (RelGTEQ) {supplied: X, expected: Y}', the Show of Mismatch in BaseTypes.hs. */
export function mismatch(relation: 'RelEQ' | 'RelGTEQ' | 'RelLTEQ', supplied: string, expected: string): string {
  return `Mismatch (${relation}) {supplied: ${supplied}, expected: ${expected}}`;
}

/** 'ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (<detail>)))'. A detail that is a quoted string stays without parentheses, as Show writes a Text argument. */
export function renderFailure(f: Failure): string {
  let text = f.rule;
  if (f.detail !== undefined) text += f.detail.startsWith('"') ? ` ${f.detail}` : ` (${f.detail})`;
  for (const wrapper of [...f.path].reverse()) text = `${wrapper} (${text})`;
  return text;
}

/** 'ConwayApplyTxError [a, b]'. */
export function formatFailures(failures: readonly Failure[]): string {
  return `ConwayApplyTxError [${failures.map(renderFailure).join(', ')}]`;
}
