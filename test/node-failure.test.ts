import { describe, expect, it } from 'vitest';
import { headFailure } from './helpers/node-failure.js';

describe('headFailure', () => {
  it('reads the first failure of a node text and of a wallet info', () => {
    // cardano-cli on cardano-node 11.0.1, rules-pv11v7.json case multi, verbatim up to the start of the tail list
    expect(
      headFailure(
        'Error: Error while submitting tx: ShelleyTxValidationError ShelleyBasedEraConway (ConwayApplyTxError (ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO Mismatch (RelGTEQ) {supplied: Coin 10, expected: Coin 162157})) :| [',
      ),
    ).toEqual(['ConwayUtxowFailure', 'UtxoFailure', 'FeeTooSmallUTxO']);
    // same node, case badSignature, verbatim
    expect(
      headFailure(
        'Error: Error while submitting tx: ShelleyTxValidationError ShelleyBasedEraConway (ConwayApplyTxError (ConwayUtxowFailure (InvalidWitnessesUTXOW (VKey (VerKeyEd25519DSIGN "e5d83a02058d730af3d9bbf74379782bb34699ac63a1bb7caf43f80055a7710b") :| [])) :| []))',
      ),
    ).toEqual(['ConwayUtxowFailure', 'InvalidWitnessesUTXOW']);
    // the wallet's own format
    expect(headFailure('ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))]')).toEqual([
      'ConwayUtxowFailure',
      'UtxoFailure',
      'UtxosFailure',
      'ValidationTagMismatch',
    ]);
    expect(headFailure('ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]')).toEqual(['ConwayMempoolFailure']);
    expect(() => headFailure('Ogmios 3999: something new')).toThrow(/no ConwayApplyTxError/);
  });
});
