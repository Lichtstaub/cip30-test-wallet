import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Transaction, TransactionWitnessSet } from '@evolution-sdk/evolution';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { encodeWitnessSet, parseTransaction } from '../src/core/cbor/tx.js';
import { baseAddressBytes, rewardAddressBytes } from '../src/core/addresses.js';
import { APIErrorCode, ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { MemoryLedger, encodeUtxo, type Utxo } from '../src/core/ledger.js';
import { parseTxHex, signTx as signParsed, signWithKeys, type SignContext } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { buildTx } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const other = deriveAccount(MNEMONIC, 1); // same seed, account 1, so a different payment key
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const otherPay = keyHash(publicKey(other.payment));
const myAddress = baseAddressBytes(0, myPay, myStake);
const otherAddress = baseAddressBytes(0, otherPay, myStake);
const scriptAddress = (() => {
  const a = new Uint8Array(myAddress);
  a[0] = 0x10; // script payment credential
  return a;
})();

const mine: Utxo = { input: syntheticInput('mine', 0n), address: myAddress, lovelace: 10_000_000n };
const theirs: Utxo = { input: syntheticInput('theirs', 0n), address: otherAddress, lovelace: 5_000_000n };
const scripts: Utxo = { input: syntheticInput('script', 0n), address: scriptAddress, lovelace: 3_000_000n };
const unknown = syntheticInput('unknown', 0n);

/** Core signTx takes a parsed transaction, the tests hand it hex like a dApp would. */
const signTx = (txHex: string, partialSign: boolean, context: SignContext) => signParsed(parseTxHex(txHex).parsed, partialSign, context);

function ctx(opts: { foreign?: Utxo[] } = {}): SignContext {
  return { payment: me.payment, stake: me.stake, ledger: new MemoryLedger({ owned: [mine], foreign: opts.foreign ?? [] }) };
}

const pay = (inputs: Parameters<typeof buildTx>[0]['inputs'], extra: Partial<Parameters<typeof buildTx>[0]> = {}) =>
  buildTx({ inputs, outputs: [{ address: otherAddress, lovelace: 1_000_000n }], fee: 200_000n, ...extra });

const witnessCount = (wsHex: string) => TransactionWitnessSet.fromCBORHex(wsHex).toJSON().vkeyWitnesses?.length ?? 0;

/** Replaces the witness set of an unsigned transaction with arbitrary raw bytes, bypassing Evolution's own validation. */
const withWitnessSet = (txHex: string, witnessSetBytes: Uint8Array) =>
  bytesToHex(concat(Uint8Array.of(0x84), parseTransaction(hexToBytes(txHex)).bodyBytes, witnessSetBytes, encode(true), encode(null)));

describe('synthetic transactions and UTxOs are valid for Evolution', () => {
  it('Evolution parses a transaction built with our encoder', () => {
    const tx = Transaction.fromCBORHex(pay([mine.input]));
    expect(tx.toJSON().body.inputs).toHaveLength(1);
  });

  it('encodes a TransactionUnspentOutput as [input, [address, coin]]', () => {
    const hex = bytesToHex(encodeUtxo(mine));
    expect(hex.startsWith('82')).toBe(true);
    expect(hex).toContain(bytesToHex(myAddress));
    const unspent = CSL.TransactionUnspentOutput.from_hex(hex);
    expect(unspent.input().transaction_id().to_hex()).toBe(bytesToHex(mine.input.txId));
    expect(unspent.output().amount().coin().to_str()).toBe(mine.lovelace.toString());
  });
});

describe('exit criterion 5: ownership decision', () => {
  it('signs an input at my own key address', async () => {
    const ws = await signTx(pay([mine.input]), false, ctx());
    expect(witnessCount(ws)).toBe(1);
  });

  it('refuses a script input as an unsupported form, signs only its own share when partial', async () => {
    const tx = pay([mine.input, scripts.input]);
    await expect(signTx(tx, false, ctx({ foreign: [scripts] }))).rejects.toThrow(/CHW_UNSUPPORTED_TX_FORM/);
    expect(witnessCount(await signTx(tx, true, ctx({ foreign: [scripts] })))).toBe(1);
  });

  it('completes a transaction another party already signed (multi-party)', async () => {
    // Party "other" signs first with the raw primitive, Evolution merges, then
    // our wallet is asked for a full signature. The foreign input is covered
    // by a valid witness, so no ProofGeneration is raised.
    const unsigned = pay([mine.input, theirs.input]);
    const theirWitness = signWithKeys(unsigned, [other.payment]);
    const partiallySigned = Transaction.addVKeyWitnessesHex(unsigned, theirWitness);
    const ws = await signTx(partiallySigned, false, ctx({ foreign: [theirs] }));
    expect(witnessCount(ws)).toBe(1);
    const fully = Transaction.addVKeyWitnessesHex(partiallySigned, ws);
    expect(Transaction.fromCBORHex(fully).toJSON().witnessSet?.vkeyWitnesses).toHaveLength(2);
  });

  it('does not accept a witness with a bad signature as coverage', async () => {
    const unsigned = pay([mine.input, theirs.input]);
    const theirWitness = signWithKeys(unsigned, [other.payment]);
    // Flip one signature byte inside the witness set hex (last byte of the hex string).
    const corrupted = theirWitness.slice(0, -2) + (theirWitness.endsWith('00') ? '01' : '00');
    const partiallySigned = Transaction.addVKeyWitnessesHex(unsigned, corrupted);
    await expect(signTx(partiallySigned, false, ctx({ foreign: [theirs] }))).rejects.toEqual(
      expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }),
    );
  });

  it('throws ProofGeneration for an uncovered foreign key input when partialSign is false', async () => {
    await expect(signTx(pay([mine.input, theirs.input]), false, ctx({ foreign: [theirs] }))).rejects.toEqual(
      expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }),
    );
  });

  it('signs what it can for a foreign key input when partialSign is true', async () => {
    const ws = await signTx(pay([mine.input, theirs.input]), true, ctx({ foreign: [theirs] }));
    expect(witnessCount(ws)).toBe(1);
  });

  it('throws a mock error, never ProofGeneration, for an unconfigured input', async () => {
    for (const partial of [false, true]) {
      let caught: unknown;
      try {
        await signTx(pay([unknown]), partial, ctx());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ChwError);
      expect((caught as ChwError).code).toBe('CHW_UNRESOLVED_INPUT');
      expect((caught as ChwError).message).toMatch(/foreignUtxos/);
    }
  });

  it('signs required signers it owns and refuses foreign ones', async () => {
    const ws = await signTx(pay([mine.input], { requiredSigners: [myPay, myStake] }), false, ctx());
    expect(witnessCount(ws)).toBe(2);
    await expect(signTx(pay([mine.input], { requiredSigners: [otherPay] }), false, ctx())).rejects.toEqual(
      expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }),
    );
    expect(witnessCount(await signTx(pay([mine.input], { requiredSigners: [otherPay] }), true, ctx()))).toBe(1);
  });

  it('signs a withdrawal from my own reward address with the stake key', async () => {
    const tx = pay([mine.input], { withdrawals: [{ rewardAddress: rewardAddressBytes(0, myStake), lovelace: 1n }] });
    expect(witnessCount(await signTx(tx, false, ctx()))).toBe(2);
  });

  it('refuses a body with certificates as an unsupported form in the spike', async () => {
    const tx = pay([mine.input], { certificatesPlaceholder: true });
    await expect(signTx(tx, false, ctx())).rejects.toBeInstanceOf(ChwError);
    await expect(signTx(tx, false, ctx())).rejects.toThrow(/CHW_UNSUPPORTED_TX_FORM/);
    expect(witnessCount(await signTx(tx, true, ctx()))).toBe(1);
  });

  it('never puts key material into an error message', async () => {
    let message = '';
    try {
      await signTx(pay([mine.input, theirs.input]), false, ctx({ foreign: [theirs] }));
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).not.toContain(bytesToHex(me.payment.bytes));
    expect(message).not.toContain(bytesToHex(me.stake.bytes));
  });
});

describe('supported transaction forms are an allowlist, checked before ownership', () => {
  it('refuses an unsupported body key (collateral inputs, 13) naming the key, signs its own share when partial', async () => {
    const tx = pay([mine.input], {
      extraBodyEntries: new Map([[13n, new Tagged(258n, [[theirs.input.txId, theirs.input.index]])]]),
    });
    await expect(signTx(tx, false, ctx())).rejects.toBeInstanceOf(ChwError);
    await expect(signTx(tx, false, ctx())).rejects.toThrow(/CHW_UNSUPPORTED_TX_FORM/);
    await expect(signTx(tx, false, ctx())).rejects.toThrow(/13/);
    expect(witnessCount(await signTx(tx, true, ctx()))).toBe(1);
  });

  it('refuses an unsupported body key (voting procedures, 19) the same way', async () => {
    const tx = pay([mine.input], { extraBodyEntries: new Map([[19n, new Map()]]) });
    await expect(signTx(tx, false, ctx())).rejects.toBeInstanceOf(ChwError);
    await expect(signTx(tx, false, ctx())).rejects.toThrow(/CHW_UNSUPPORTED_TX_FORM/);
    expect(witnessCount(await signTx(tx, true, ctx()))).toBe(1);
  });

  it('refuses a script withdrawal as an unsupported form, never ProofGeneration', async () => {
    const scriptReward = new Uint8Array(29);
    scriptReward[0] = 0xf0; // reward address, script credential
    const tx = pay([mine.input], { withdrawals: [{ rewardAddress: scriptReward, lovelace: 1n }] });
    let caught: unknown;
    try {
      await signTx(tx, false, ctx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChwError);
    expect((caught as ChwError).code).toBe('CHW_UNSUPPORTED_TX_FORM');
  });

  it('reports unsupported form, not ProofGeneration, for a foreign key input alongside a certificate', async () => {
    const tx = pay([mine.input, theirs.input], { certificatesPlaceholder: true });
    let caught: unknown;
    try {
      await signTx(tx, false, ctx({ foreign: [theirs] }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChwError);
    expect((caught as ChwError).code).toBe('CHW_UNSUPPORTED_TX_FORM');
  });
});

describe('signTx error boundary', () => {
  it('ignores a malformed witness (31-byte vkey) as coverage and refuses the foreign input', async () => {
    const unsigned = pay([mine.input, theirs.input]);
    const junkWitnessSet = encodeWitnessSet([{ vkey: new Uint8Array(31), signature: new Uint8Array(64) }]);
    const tampered = withWitnessSet(unsigned, junkWitnessSet);
    await expect(signTx(tampered, false, ctx({ foreign: [theirs] }))).rejects.toEqual(
      expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }),
    );
  });

  it('treats a 32 byte witness that is no curve point as no coverage, never as a raw error', async () => {
    const tampered = withWitnessSet(pay([mine.input, theirs.input]), encodeWitnessSet([{ vkey: new Uint8Array(32).fill(0xff), signature: new Uint8Array(64).fill(0xff) }]));
    await expect(signTx(tampered, false, ctx({ foreign: [theirs] }))).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
  });

  it('parseTxHex reports InvalidRequest with the reason for bad hex and for input that is not valid CBOR', () => {
    const thrown = (tx: unknown) => {
      try {
        parseTxHex(tx);
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(thrown('ffff')).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    expect(thrown('zz')).toEqual({ code: APIErrorCode.InvalidRequest, info: 'tx must be a hex string' });
    expect(thrown(42)).toEqual({ code: APIErrorCode.InvalidRequest, info: 'tx must be a hex string' });
    expect(thrown(pay([mine.input]) + '00')).toEqual({ code: APIErrorCode.InvalidRequest, info: 'cbor: trailing bytes after item' });
  });
});
