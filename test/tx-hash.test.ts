import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Transaction, TransactionBody, TransactionHash } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { existingVKeyWitnesses, extractBodyBytes, parseBody, txHash } from '../src/core/cbor/tx.js';
import { buildTx } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';
import { FIXTURE_BODY_LENGTH, FIXTURE_TX_HASH } from './fixtures/vectors.js';

const fixtureHex = readFileSync('test/fixtures/preprod-0a399be6.hex', 'utf8').trim();
const fixture = hexToBytes(fixtureHex);

describe('exit criterion 1: body hash', () => {
  it('slices the body without re-encoding and matches Evolution byte for byte', () => {
    const ours = extractBodyBytes(fixture);
    const theirs = Transaction.extractBodyBytes(fixture);
    expect(ours.length).toBe(FIXTURE_BODY_LENGTH);
    expect(bytesToHex(ours)).toBe(bytesToHex(theirs));
  });

  it('hashes the body to the transaction id', () => {
    expect(bytesToHex(txHash(fixture))).toBe(FIXTURE_TX_HASH);
    const evo = TransactionHash.toHex(TransactionBody.toHashFromBytes(extractBodyBytes(fixture)));
    expect(evo).toBe(FIXTURE_TX_HASH);
  });

  it('parses inputs and required signers from the fixture', () => {
    const body = parseBody(fixture);
    expect(body.inputs).toHaveLength(1);
    expect(body.inputs[0]!.txId).toHaveLength(32);
    expect(body.requiredSigners).toEqual([]);
    expect(body.withdrawals).toEqual([]);
    expect(body.bodyKeys).not.toContain(4n);
  });

  it('reads the vkey witnesses the fixture already carries', () => {
    const witnesses = existingVKeyWitnesses(fixture);
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]!.vkey).toHaveLength(32);
    expect(witnesses[0]!.signature).toHaveLength(64);
  });

  it('rejects something that is not a 4-element transaction array', () => {
    expect(() => extractBodyBytes(hexToBytes('83010203'))).toThrow(/transaction/i); // definite, 3 items
    expect(() => extractBodyBytes(hexToBytes('9f010203ff'))).toThrow(/transaction/i); // indefinite, 3 items
    expect(() => extractBodyBytes(hexToBytes('a0'))).toThrow(/transaction/i); // not an array
  });

  it('accepts an indefinite-length transaction array with exactly 4 items', () => {
    expect(bytesToHex(extractBodyBytes(hexToBytes('9fa0a0f5f6ff')))).toBe('a0');
  });

  it('rejects a tag 24 wrapper around the inputs, only tag 258 is a set', () => {
    const tx = buildTx({
      inputs: [syntheticInput('x', 0n)],
      outputs: [{ address: new Uint8Array(29), lovelace: 1_000_000n }],
      fee: 100_000n,
      extraBodyEntries: new Map([[0n, new Tagged(24n, [[new Uint8Array(32), 0n]])]]),
    });
    expect(() => parseBody(hexToBytes(tx))).toThrow(/tag 258/);
  });
});
