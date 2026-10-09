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
  UTXOS: ['ConwayUtxowFailure', 'UtxoFailure', 'UtxosFailure'],
  UTXOW: ['ConwayUtxowFailure'],
  DELEG: ['ConwayCertsFailure', 'CertFailure', 'DelegFailure'],
  POOL: ['ConwayCertsFailure', 'CertFailure', 'PoolFailure'],
  GOVCERT: ['ConwayCertsFailure', 'CertFailure', 'GovCertFailure'],
  GOV: ['ConwayGovFailure'],
  LEDGER: [],
} as const;

/** Pushes a failure under one path onto failures. A failure without detail has no detail key. */
export function failer(path: readonly string[], failures: Failure[]): (rule: string, detail?: string) => void {
  return (rule, detail) => {
    failures.push(detail === undefined ? { path, rule } : { path, rule, detail });
  };
}

/** '[a, b]', the bracketed list the details use for sets and lists. */
export function list(items: Iterable<string>): string {
  return `[${[...items].join(', ')}]`;
}

/** 'Coin 5'. */
export function coin(c: bigint): string {
  return `Coin ${c}`;
}

/** Mainnet for 1, Testnet for 0, as Show writes a Network. */
export function network(id: bigint | number): string {
  const n = BigInt(id);
  return n === 1n ? 'Mainnet' : n === 0n ? 'Testnet' : `Network ${id}`;
}

/** 'Mismatch (RelGTEQ) {supplied: X, expected: Y}', the Show of Mismatch in BaseTypes.hs. */
export function mismatch(relation: 'RelEQ' | 'RelGTEQ' | 'RelLTEQ', supplied: string, expected: string): string {
  return `Mismatch (${relation}) {supplied: ${supplied}, expected: ${expected}}`;
}

/**
 * After Haskell's Show of a Text: in double quotes, with backslash escapes for
 * quote, backslash, newline, tab and carriage return, and every character
 * outside ASCII as its decimal code point, \& separating such an escape from a
 * digit after it. Show names the other control characters (\SOH, \DEL), here
 * they are decimal too.
 */
export function showText(text: string): string {
  let out = '"';
  let numeric = false;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (numeric && char >= '0' && char <= '9') out += '\\&';
    numeric = false;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\t') out += '\\t';
    else if (char === '\r') out += '\\r';
    else if (code < 0x20 || code >= 0x7f) {
      out += `\\${code}`;
      numeric = true;
    } else out += char;
  }
  return `${out}"`;
}

/**
 * 'ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (<detail>)))'. A detail that is a quoted string stays without
 * parentheses, as Show writes a Text argument. A detail that starts with a parenthesis holds several arguments,
 * each already where Show puts its parentheses, and stays as it is.
 */
export function renderFailure(f: Failure): string {
  let text = f.rule;
  if (f.detail !== undefined) text += f.detail.startsWith('"') || f.detail.startsWith('(') ? ` ${f.detail}` : ` (${f.detail})`;
  for (const wrapper of [...f.path].reverse()) text = `${wrapper} (${text})`;
  return text;
}

/** 'ConwayApplyTxError [a, b]'. */
export function formatFailures(failures: readonly Failure[]): string {
  return `ConwayApplyTxError [${failures.map(renderFailure).join(', ')}]`;
}
