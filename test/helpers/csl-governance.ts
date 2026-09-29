// Builds governance transactions with CSL, an independent Rust codebase, so
// the parser and the witness table are checked against bytes we did not write.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

export type CslCert = (c: typeof CSL) => CSL.Certificate;

export interface CslGovernanceTx {
  input: { txId: Uint8Array; index: number };
  certificates?: CslCert[];
  drepVote?: Uint8Array; // DRep key hash that votes Yes on a fixed action
  infoProposal?: { rewardAddressHex: string };
}

export function cslGovernanceTx(opts: CslGovernanceTx): string {
  const inputs = CSL.TransactionInputs.new();
  inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(opts.input.txId), opts.input.index));
  const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), CSL.BigNum.from_str('200000'));
  if (opts.certificates?.length) {
    const certs = CSL.Certificates.new();
    for (const make of opts.certificates) certs.add(make(CSL));
    body.set_certs(certs);
  }
  if (opts.drepVote) {
    const votes = CSL.VotingProcedures.new();
    votes.insert(
      CSL.Voter.new_drep_credential(CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(opts.drepVote))),
      CSL.GovernanceActionId.new(CSL.TransactionHash.from_bytes(new Uint8Array(32).fill(3)), 0),
      CSL.VotingProcedure.new(CSL.VoteKind.Yes),
    );
    body.set_voting_procedures(votes);
  }
  if (opts.infoProposal) {
    const proposals = CSL.VotingProposals.new();
    const anchor = CSL.Anchor.new(CSL.URL.new('https://example.com/p.json'), CSL.AnchorDataHash.from_bytes(new Uint8Array(32)));
    const reward = CSL.RewardAddress.from_address(CSL.Address.from_hex(opts.infoProposal.rewardAddressHex))!;
    proposals.add(CSL.VotingProposal.new(CSL.GovernanceAction.new_info_action(CSL.InfoAction.new()), anchor, reward, CSL.BigNum.from_str('100000000000')));
    body.set_voting_proposals(proposals);
  }
  return CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_hex();
}

/** The transaction id CSL computes over the body of a transaction, as hex. */
export function cslTxId(txHex: string): string {
  return CSL.FixedTransaction.from_hex(txHex).transaction_hash().to_hex();
}

/** Verifies every vkey witness of a witness set over the transaction id with CSL and returns the public keys that verified. */
export function cslVerifiedKeys(txHex: string, witnessSetHex: string): string[] {
  const id = CSL.FixedTransaction.from_hex(txHex).transaction_hash();
  const vkeys = CSL.TransactionWitnessSet.from_hex(witnessSetHex).vkeys();
  const ok: string[] = [];
  for (let i = 0; i < (vkeys?.len() ?? 0); i++) {
    const w = vkeys!.get(i);
    if (w.vkey().public_key().verify(id.to_bytes(), w.signature())) ok.push(w.vkey().public_key().to_hex());
  }
  return ok;
}

/** The same check over the witness set a complete transaction carries, for "merged without loss". */
export function cslVerifiedKeysOfTx(txHex: string): string[] {
  return cslVerifiedKeys(txHex, CSL.Transaction.from_hex(txHex).witness_set().to_hex());
}

/** Number of vkey witnesses in a complete transaction, verified or not, so a broken extra witness is noticed too. */
export function cslWitnessCount(txHex: string): number {
  return CSL.Transaction.from_hex(txHex).witness_set().vkeys()?.len() ?? 0;
}

/** Union of the vkey witnesses already in a transaction and a new witness set, for merges that bypass Evolution. */
export function mergeWitnessSets(txHex: string, witnessSetHex: string): string {
  const all = CSL.Vkeywitnesses.new();
  for (const source of [CSL.Transaction.from_hex(txHex).witness_set(), CSL.TransactionWitnessSet.from_hex(witnessSetHex)]) {
    const vkeys = source.vkeys();
    for (let i = 0; i < (vkeys?.len() ?? 0); i++) all.add(vkeys!.get(i));
  }
  const ws = CSL.TransactionWitnessSet.new();
  ws.set_vkeys(all);
  return ws.to_hex();
}
