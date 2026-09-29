import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { buildTx } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';

const input = syntheticInput('gov', 0n);
const out = [{ address: hexToBytes('00' + '11'.repeat(56)), lovelace: 1_000_000n }];
const hash28 = (n: number) => new Uint8Array(28).fill(n);
const parse = (hex: string) => parseTransaction(hexToBytes(hex)).body;

describe('parser: certificates, voters, proposals', () => {
  it('reads certificates as a plain array and as tag 258, raw and in order', () => {
    const certs = [[9n, [0n, hash28(1)], [0n, hash28(2)]], [18n, [0n, hash28(2)], null]];
    for (const wrapped of [certs, new Tagged(258n, certs)]) {
      const body = parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[4n, wrapped]]) }));
      expect(body.certificates.map((c) => c[0])).toEqual([9n, 18n]);
    }
  });

  it('reads voters from the voting procedures map', () => {
    const govActionId = [new Uint8Array(32).fill(3), 0n];
    const votes = new Map([[[2n, hash28(2)], new Map([[govActionId, [1n, null]]])]]);
    const body = parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[19n, votes]]) }));
    expect(body.voters).toEqual([{ type: 2n, hash: hash28(2) }]);
  });

  it('reads proposals as a plain array and as tag 258, with the guardrail hash where the action carries one', () => {
    const anchor = ['https://example.com/a.json', new Uint8Array(32)];
    const reward = hexToBytes('e0' + '01'.repeat(28));
    const info = [100n, reward, [6n], anchor];
    const treasury = [100n, reward, [2n, new Map([[reward, 5n]]), hash28(9)], anchor];
    for (const wrapped of [[info, treasury], new Tagged(258n, [info, treasury])]) {
      const body = parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[20n, wrapped]]) }));
      expect(body.proposals).toEqual([{ actionIndex: 6n }, { actionIndex: 2n, guardrail: hash28(9) }]);
    }
  });

  it('reads the guardrail of a parameter change, null guardrails, and rejects a guardrail that is neither null nor bytes', () => {
    const anchor = ['https://example.com/a.json', new Uint8Array(32)];
    const reward = hexToBytes('e0' + '01'.repeat(28));
    const proposalsOf = (action: unknown[]) =>
      parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[20n, [[100n, reward, action, anchor]]]]) })).proposals;
    expect(proposalsOf([0n, null, new Map(), hash28(7)])).toEqual([{ actionIndex: 0n, guardrail: hash28(7) }]);
    expect(proposalsOf([2n, new Map([[reward, 5n]]), null])).toEqual([{ actionIndex: 2n }]);
    expect(() => proposalsOf([2n, new Map([[reward, 5n]]), 'text'])).toThrow(/malformed governance action/);
    expect(() => proposalsOf([0n, null, new Map(), 'text'])).toThrow(/malformed governance action/);
  });

  it('reads a transaction CSL built with Conway certificates and a vote', () => {
    const stake = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(hash28(1)));
    const drep = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(hash28(2)));
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), CSL.BigNum.from_str('200000'));
    const certs = CSL.Certificates.new();
    certs.add(CSL.Certificate.new_vote_delegation(CSL.VoteDelegation.new(stake, CSL.DRep.new_key_hash(CSL.Ed25519KeyHash.from_bytes(hash28(2))))));
    certs.add(CSL.Certificate.new_drep_update(CSL.DRepUpdate.new(drep)));
    body.set_certs(certs);
    const votes = CSL.VotingProcedures.new();
    votes.insert(
      CSL.Voter.new_drep_credential(drep),
      CSL.GovernanceActionId.new(CSL.TransactionHash.from_bytes(new Uint8Array(32).fill(3)), 0),
      CSL.VotingProcedure.new(CSL.VoteKind.Yes),
    );
    body.set_voting_procedures(votes);
    const tx = CSL.Transaction.new(body, CSL.TransactionWitnessSet.new());
    const parsed = parse(tx.to_hex());
    expect(parsed.certificates.map((c) => c[0])).toEqual([9n, 18n]);
    expect(parsed.voters).toEqual([{ type: 2n, hash: hash28(2) }]);
  });

  it('rejects an empty certificate, vote or proposal list, a certificate without an integer index, and a malformed voter', () => {
    const bad = (key: bigint, value: unknown) => () =>
      parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[key, value]]) }));
    expect(bad(4n, [])).toThrow(/certificates must not be empty/);
    expect(bad(20n, new Tagged(258n, []))).toThrow(/proposal procedures must not be empty/);
    expect(bad(19n, new Map())).toThrow(/voting procedures must not be empty/);
    expect(bad(4n, [['x']])).toThrow(/malformed certificate/);
    expect(bad(4n, [7n])).toThrow(/malformed certificate/);
    expect(bad(19n, new Map([[[2n], new Map()]]))).toThrow(/malformed voter/);
    expect(bad(19n, new Map([[[2n, hash28(2)], new Map()]]))).toThrow(/at least one vote/);
    expect(bad(19n, [])).toThrow(/voting procedures must be a map/);
  });

  it('accepts a pre-Conway certificate that carries only its index, so requirements can report it as deprecated', () => {
    const body = parse(buildTx({ inputs: [input], outputs: out, fee: 1n, extraBodyEntries: new Map([[4n, [[5n]]]]) }));
    expect(body.certificates).toEqual([[5n]]);
  });
});
