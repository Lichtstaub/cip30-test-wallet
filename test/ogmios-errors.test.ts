import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PATH, renderFailure } from '../src/host/checks/failure.js';
import { parseJsonBig } from '../src/host/chain/json.js';
import { failureFromOgmios, rejectionInfo } from '../src/host/chain/ogmios-errors.js';
import type { OgmiosError } from '../src/host/chain/provider.js';

// Refusals recorded from Ogmios, see test/fixtures/ogmios/errors/README.md.

const DIR = 'test/fixtures/ogmios/errors';
const text = (file: string) => readFileSync(`${DIR}/${file}`, 'utf8');
/** The error of a recorded JSON-RPC answer, or the error object a file holds on its own. */
const recorded = (file: string): OgmiosError => {
  const json = JSON.parse(text(file)) as { error?: OgmiosError };
  return json.error ?? (json as unknown as OgmiosError);
};
/** The first error line cardano-cli printed for each case, all on cardano-node 11.0.1. */
const CLI = JSON.parse(text('cardano-cli.json')) as Record<string, string>;
/** Path and rule as the head of the node's Show text: the failure without detail and without its closing parentheses. */
const head = (file: string) => {
  const failure = failureFromOgmios(recorded(file))!;
  return renderFailure({ path: failure.path, rule: failure.rule }).replace(/\)+$/, '');
};

describe('Ogmios refusals as node rules', () => {
  it.each([
    ['3100-invalid-signatories.json', 'ConwayApplyTxError [ConwayUtxowFailure (InvalidWitnessesUTXOW ([e5d83a02058d730af3d9bbf74379782bb34699ac63a1bb7caf43f80055a7710b]))]'],
    ['3101-missing-signatories.json', 'ConwayApplyTxError [ConwayUtxowFailure (MissingVKeyWitnessesUTXOW ([77da02be0024494694a26dd63651314e60eb915c3f3431d63e0f6300]))]'],
    [
      '3113-script-integrity.json',
      'ConwayApplyTxError [ConwayUtxowFailure (ScriptIntegrityHashMismatch (Mismatch (RelEQ) {supplied: SJust 0000000000000000000000000000000000000000000000000000000000000000, expected: SJust f077618a346e3e1e8d3a088a488dd500dc97e5bd7446c94ce935276a8c02618b}))]',
    ],
    ['3117-unknown-output-references.json', 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (BadInputsUTxO ([4c3819269b1f5ad9d0c0824f9c90459cc93f6c3f4a45b67f6a155e21fc0a3bcf#0])))]'],
    [
      '3118-outside-validity-interval.json',
      'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (OutsideValidityIntervalUTxO ({invalidBefore: SNothing, invalidHereafter: SJust (SlotNo 1), slot: SlotNo 4})))]',
    ],
    ['3122-fee-too-small.json', 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Mismatch (RelGTEQ) {supplied: Coin 1000, expected: Coin 165149})))]'],
    ['3123-value-not-conserved.json', 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (ValueNotConservedUTxO (Mismatch (RelEQ) {supplied: Coin 20000000, expected: Coin 25200000})))]'],
    [
      '3124-network-mismatch.json',
      'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (WrongNetwork ({expected: Testnet, addresses: [addr1q9ma5q47qqjyj3555fkavdj3x98xp6u3tslngvwk8c8kxqz3n89nypu7zcpuh68wcd5jptznzn3tpadjch0ymqaw9czs5yaqlk]})))]',
    ],
    [
      '3125-insufficiently-funded-outputs.json',
      'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (BabbageOutputTooSmallUTxO ([(addr_test1qz8u82nz0pdydcxcxpljqv4eyldgus88s87lnljfh2pzsgr6nfmk862zd6wpf64vt4gklza3skl3j67yv7sjm2q2w89s395hqm, Coin 961130)])))]',
    ],
    [
      '3134-execution-units-too-large.json',
      'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (ExUnitsTooBigUTxO (Mismatch (RelLTEQ) {supplied: ExUnits {mem: 999000000, steps: 1000000000}, expected: ExUnits {mem: 10000000, steps: 10000000000}})))]',
    ],
    ['3136-failed-unexpectedly.json', 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) FailedUnexpectedly)))]'],
    ['3136-passed-unexpectedly.json', 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))]'],
    ['3997-all-inputs-spent.json', 'ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]'],
  ])('%s', (file, info) => {
    expect(rejectionInfo(recorded(file))).toBe(info);
  });

  it.each([
    ['3100-invalid-signatories.json', 'bad-signature'],
    ['3101-missing-signatories.json', 'missing-witness'],
    ['3101-missing-signatories.json', 'wrong-witness'],
    ['3113-script-integrity.json', 'wrong-integrity-hash'],
    ['3117-unknown-output-references.json', 'combined'],
    ['3118-outside-validity-interval.json', 'expired-ttl'],
    ['3122-fee-too-small.json', 'fee-too-small'],
    ['3123-value-not-conserved.json', 'value-not-conserved'],
    ['3124-network-mismatch.json', 'wrong-network'],
    ['3125-insufficiently-funded-outputs.json', 'output-too-small'],
    ['3134-execution-units-too-large.json', 'exunits-too-big'],
    ['3136-failed-unexpectedly.json', 'plutus-fail-isvalid-true'],
    ['3136-passed-unexpectedly.json', 'isvalid-false-but-succeeds'],
    ['3997-all-inputs-spent.json', 'bad-inputs'],
  ])('%s has the path and rule cardano-cli printed for %s', (file, cliCase) => {
    expect(CLI[cliCase]).toContain(head(file));
  });

  it('3113 is ScriptIntegrityHashMismatch, the name of the local check, as node 11.0.1 prints it', () => {
    expect(head('3113-script-integrity.json')).toBe('ConwayUtxowFailure (ScriptIntegrityHashMismatch');
    expect(CLI['wrong-integrity-hash']).toContain('ConwayUtxowFailure (ScriptIntegrityHashMismatch Mismatch (RelEQ) {supplied: SJust (SafeHash "0000');
  });

  it('3136 prints IsValid as node 11.0.1 does, for both directions', () => {
    expect(CLI['plutus-fail-isvalid-true']).toContain('ValidationTagMismatch (IsValid True) (FailedUnexpectedly');
    expect(CLI['isvalid-false-but-succeeds']).toContain('ValidationTagMismatch (IsValid False) PassedUnexpectedly');
  });

  it('3997 reads the same as the mempool check of the local ledger checks', () => {
    expect(failureFromOgmios(recorded('3997-all-inputs-spent.json'))).toStrictEqual({
      path: PATH.LEDGER,
      rule: 'ConwayMempoolFailure',
      detail: '"All inputs are spent. Transaction has probably already been included"',
    });
  });

  it('keeps the text of a code outside the table, also of a JSON-RPC code that submit raises as a transport error', () => {
    const invalid = recorded('koios-invalid-transaction.json');
    expect(failureFromOgmios(invalid)).toBeUndefined();
    expect(rejectionInfo(invalid)).toBe(`Ogmios -32602: ${invalid.message}`);
    expect(rejectionInfo(invalid)).toMatch(/^Ogmios -32602: Invalid transaction; It looks like the given transaction wasn't well-formed\./);
  });

  it('names no rule for a code that stands for several node rules', () => {
    // The shape of the Ogmios test vectors. 3146 covers an unregistered stake key and an unregistered DRep delegatee.
    const error = {
      code: 3146,
      message: 'The transaction references an unknown stake credential.',
      data: { from: 'script', unknownCredential: '4c3a72d90c81961d529f51f1ed34c48698cec2956f41b40b06fb3465' },
    };
    expect(failureFromOgmios(error)).toBeUndefined();
    expect(rejectionInfo(error)).toBe('Ogmios 3146: The transaction references an unknown stake credential.');
  });

  it('names WrongNetwork for 3124 only when an address is on the wrong network', () => {
    const error = { ...recorded('3124-network-mismatch.json'), data: { discriminatedType: 'transaction', expectedNetwork: 'testnet' } };
    expect(failureFromOgmios(error)).toBeUndefined();
    expect(rejectionInfo(error)).toBe(`Ogmios 3124: ${error.message}`);
  });

  it.each([
    ['3122 without data', { code: 3122, message: 'm' }, 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO))]'],
    ['3122 with a fee that is no number', { code: 3122, message: 'm', data: { providedFee: { ada: { lovelace: 'abc' } }, minimumRequiredFee: { ada: { lovelace: 5 } } } }, 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO))]'],
    ['3117 with an outpoint that is no outpoint', { code: 3117, message: 'm', data: { unknownOutputReferences: [{ transaction: { id: 'zz' }, index: 0 }] } }, 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (BadInputsUTxO))]'],
    ['3123 with values that are no values', { code: 3123, message: 'm', data: { valueConsumed: { ada: {} }, valueProduced: 7 } }, 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (ValueNotConservedUTxO))]'],
    ['3136 with an unknown declaredSpending', { code: 3136, message: 'm', data: { declaredSpending: 'both' } }, 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch)))]'],
    ['3997 with data that is no object', { code: 3997, message: 'm', data: 'spent' }, 'ConwayApplyTxError [ConwayMempoolFailure]'],
  ])('%s gives the rule without detail', (_name, error, info) => {
    expect(rejectionInfo(error)).toBe(info);
    expect(failureFromOgmios(error)).not.toHaveProperty('detail');
  });

  it('reads integers past 2^53 that parseJsonBig kept as strings', () => {
    // The recorded answer with the consumed lovelace raised to 2^64 - 1, read the way the client reads an answer.
    const raised = text('3123-value-not-conserved.json').replace('"lovelace": 20000000', '"lovelace": 18446744073709551615');
    const answer = parseJsonBig(raised) as { error: OgmiosError };
    expect(failureFromOgmios(answer.error)?.detail).toBe('Mismatch (RelEQ) {supplied: Coin 18446744073709551615, expected: Coin 25200000}');
  });

  it('writes a value with assets as the local checks do', () => {
    const policy = '41f08518e801ca998fc0536422c8760580bc40d95fe1c5f272d0ffe5';
    const error = {
      code: 3123,
      message: 'm',
      data: { valueConsumed: { ada: { lovelace: 2000000 }, [policy]: { '3431': '9007199254740993' } }, valueProduced: { ada: { lovelace: 2000000 } } },
    };
    expect(failureFromOgmios(error)?.detail).toBe(
      `Mismatch (RelEQ) {supplied: MaryValue (Coin 2000000) (MultiAsset (fromList [(PolicyID {policyID = ScriptHash "${policy}"},fromList [("3431",9007199254740993)])])), expected: Coin 2000000}`,
    );
  });
});
