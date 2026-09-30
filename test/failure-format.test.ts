import { describe, expect, it } from 'vitest';
import { formatFailures, mismatch, PATH, renderFailure } from '../src/host/checks/failure.js';

describe('failure format', () => {
  it('writes a mismatch like the ledger shows it', () => {
    expect(mismatch('RelGTEQ', 'Coin 150000', 'Coin 170000')).toBe('Mismatch (RelGTEQ) {supplied: Coin 150000, expected: Coin 170000}');
    expect(mismatch('RelEQ', 'Coin 1', 'Coin 2')).toBe('Mismatch (RelEQ) {supplied: Coin 1, expected: Coin 2}');
    expect(mismatch('RelLTEQ', '17000', '16384')).toBe('Mismatch (RelLTEQ) {supplied: 17000, expected: 16384}');
  });

  it.each([
    [
      'a UTXO failure with a detail',
      { path: PATH.UTXO, rule: 'FeeTooSmallUTxO', detail: mismatch('RelGTEQ', 'Coin 150000', 'Coin 170000') },
      'ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Mismatch (RelGTEQ) {supplied: Coin 150000, expected: Coin 170000})))',
    ],
    ['a UTXOW failure without a detail', { path: PATH.UTXOW, rule: 'MissingScriptWitnessesUTXOW' }, 'ConwayUtxowFailure (MissingScriptWitnessesUTXOW)'],
    [
      'a DELEG failure',
      { path: PATH.DELEG, rule: 'StakeKeyNotRegisteredDELEG', detail: 'KeyHashObj (KeyHash {unKeyHash = "01"})' },
      'ConwayCertsFailure (CertFailure (DelegFailure (StakeKeyNotRegisteredDELEG (KeyHashObj (KeyHash {unKeyHash = "01"})))))',
    ],
    ['a POOL failure', { path: PATH.POOL, rule: 'StakePoolNotRegisteredOnKeyPOOL', detail: 'x' }, 'ConwayCertsFailure (CertFailure (PoolFailure (StakePoolNotRegisteredOnKeyPOOL (x))))'],
    ['a GOVCERT failure', { path: PATH.GOVCERT, rule: 'ConwayDRepNotRegistered', detail: 'x' }, 'ConwayCertsFailure (CertFailure (GovCertFailure (ConwayDRepNotRegistered (x))))'],
    ['a GOV failure', { path: PATH.GOV, rule: 'ProposalDepositIncorrect', detail: 'x' }, 'ConwayGovFailure (ProposalDepositIncorrect (x))'],
    ['a LEDGER failure', { path: PATH.LEDGER, rule: 'ConwayTxRefScriptsSizeTooBig', detail: 'x' }, 'ConwayTxRefScriptsSizeTooBig (x)'],
    [
      'a quoted text detail without parentheses',
      { path: PATH.LEDGER, rule: 'ConwayMempoolFailure', detail: '"All inputs are spent. Transaction has probably already been included"' },
      'ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"',
    ],
  ])('renders %s', (_name, failure, text) => {
    expect(renderFailure(failure)).toBe(text);
  });

  it('lists every failure in one ConwayApplyTxError', () => {
    const fee = { path: PATH.UTXO, rule: 'FeeTooSmallUTxO', detail: mismatch('RelGTEQ', 'Coin 1', 'Coin 2') };
    const witness = { path: PATH.UTXOW, rule: 'MissingScriptWitnessesUTXOW' };
    expect(formatFailures([witness, fee])).toBe(
      'ConwayApplyTxError [ConwayUtxowFailure (MissingScriptWitnessesUTXOW), ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Mismatch (RelGTEQ) {supplied: Coin 1, expected: Coin 2})))]',
    );
    expect(formatFailures([])).toBe('ConwayApplyTxError []');
  });
});
