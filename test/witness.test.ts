import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Ed25519Signature, Transaction, TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import { baseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { encodeWitnessSet, txHash } from '../src/core/cbor/tx.js';
import { decode } from '../src/core/cbor/decode.js';
import { publicKey } from '../src/core/keys.js';
import { syntheticInput } from '../src/core/ledger.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { buildTx } from './helpers/build-tx.js';
import { MNEMONIC } from './fixtures/vectors.js';

const fixtureHex = readFileSync('test/fixtures/preprod-0a399be6.hex', 'utf8').trim();

describe('encodeWitnessSet', () => {
  it('produces { 0: [[vkey, sig]] } as a plain array', () => {
    const vkey = new Uint8Array(32).fill(1);
    const signature = new Uint8Array(64).fill(2);
    const ws = decode(encodeWitnessSet([{ vkey, signature }])) as Map<bigint, unknown>;
    expect(ws.size).toBe(1);
    const list = ws.get(0n) as Uint8Array[][];
    expect(list).toHaveLength(1);
    expect(bytesToHex(list[0]![0]!)).toBe(bytesToHex(vkey));
    expect(bytesToHex(list[0]![1]!)).toBe(bytesToHex(signature));
  });

  it('encodes an empty witness set as an empty map', () => {
    expect(bytesToHex(encodeWitnessSet([]))).toBe('a0');
  });
});

describe('exit criterion 2: witness accepted by Evolution and verifiable', () => {
  const account = deriveAccount(MNEMONIC);

  it('returns a witness set Evolution parses, with a signature over the body hash', () => {
    const wsHex = signWithKeys(fixtureHex, [account.payment]);
    const ws = TransactionWitnessSet.fromCBORHex(wsHex).toJSON();
    expect(ws.vkeyWitnesses).toHaveLength(1);
    const w = ws.vkeyWitnesses![0]!;
    expect(VKey.toHex(w.vkey)).toBe(bytesToHex(publicKey(account.payment)));
    // Evolution's toJSON() gives an Ed25519Signature object, not a plain hex string.
    const sig = Ed25519Signature.toBytes(w.signature);
    expect(ed25519.verify(sig, txHash(hexToBytes(fixtureHex)), publicKey(account.payment))).toBe(true);
    expect(CSL.TransactionWitnessSet.from_hex(wsHex).vkeys()?.len()).toBe(1);
  });

  it('adds one witness per key', () => {
    const wsHex = signWithKeys(fixtureHex, [account.payment, account.stake]);
    expect(TransactionWitnessSet.fromCBORHex(wsHex).toJSON().vkeyWitnesses).toHaveLength(2);
  });

  it('returns only the witnesses created by this call, never the existing ones', () => {
    // The fixture already carries one foreign vkey witness. Ours must not echo it.
    const wsHex = signWithKeys(fixtureHex, [account.payment]);
    expect(TransactionWitnessSet.fromCBORHex(wsHex).toJSON().vkeyWitnesses).toHaveLength(1);
  });
});

describe('exit criterion 4: consumer merge keeps foreign witnesses', () => {
  it('Evolution merges our witness set into a transaction that already has one', () => {
    const account = deriveAccount(MNEMONIC);
    const before = Transaction.fromCBORHex(fixtureHex).toJSON().witnessSet?.vkeyWitnesses ?? [];
    expect(before).toHaveLength(1);
    const foreignVkey = VKey.toHex(before[0]!.vkey);

    const merged = Transaction.addVKeyWitnessesHex(fixtureHex, signWithKeys(fixtureHex, [account.payment]));
    const after = Transaction.fromCBORHex(merged).toJSON().witnessSet?.vkeyWitnesses ?? [];
    expect(after).toHaveLength(2);
    expect(after.map((w) => VKey.toHex(w.vkey))).toContain(foreignVkey);
    expect(after.map((w) => VKey.toHex(w.vkey))).toContain(bytesToHex(publicKey(account.payment)));

    // The body is untouched by the merge, so the id is unchanged.
    expect(bytesToHex(txHash(hexToBytes(merged)))).toBe(bytesToHex(txHash(hexToBytes(fixtureHex))));
  });
});

describe('pinned Evolution behaviour: a plain-array set is not preserved on merge', () => {
  it('changes the body hash when Evolution normalizes a plain-array input set to tag 258', () => {
    const account = deriveAccount(MNEMONIC);
    const tx = buildTx({
      inputs: [syntheticInput('plain-array', 0n)],
      outputs: [{ address: baseAddressBytes(0, new Uint8Array(28), new Uint8Array(28)), lovelace: 1_000_000n }],
      fee: 200_000n,
      plainArraySets: true,
    });
    const before = txHash(hexToBytes(tx));
    const witness = signWithKeys(tx, [account.payment]);
    const merged = Transaction.addVKeyWitnessesHex(tx, witness);
    const after = txHash(hexToBytes(merged));
    // Evolution always emits the tag 258 form for sets, so a plain array
    // input set gets rewritten on merge, changing the body bytes and the
    // hash. This is what motivates expectSignedBy in milestone 2, a
    // signature made before a consumer re-encodes the body is void.
    expect(bytesToHex(after)).not.toBe(bytesToHex(before));
  });
});
