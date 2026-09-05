import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Transaction, TransactionBody, TransactionHash } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { MemoryLedger } from '../src/core/ledger.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { FIXTURE_TX_HASH, MNEMONIC } from './fixtures/vectors.js';

const fixtureHex = readFileSync('test/fixtures/preprod-0a399be6.hex', 'utf8').trim();

describe('exit criterion 6: submitTx returns hash32 and records the transaction', () => {
  it('returns the same id Evolution computes and stores the exact bytes', async () => {
    const account = deriveAccount(MNEMONIC);
    const signedHex = Transaction.addVKeyWitnessesHex(fixtureHex, signWithKeys(fixtureHex, [account.payment]));
    const signed = hexToBytes(signedHex);

    const ledger = new MemoryLedger({ owned: [] });
    const id = await ledger.submit(signed);

    const evo = TransactionHash.toHex(TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(signed)));
    expect(bytesToHex(id)).toBe(evo);
    expect(bytesToHex(id)).toBe(FIXTURE_TX_HASH);
    expect(ledger.submitted).toHaveLength(1);
    expect(bytesToHex(ledger.submitted[0]!)).toBe(signedHex);
  });

  it('keeps the id stable no matter how many witnesses are attached', async () => {
    const ledger = new MemoryLedger({ owned: [] });
    const a = await ledger.submit(hexToBytes(fixtureHex));
    expect(bytesToHex(a)).toBe(FIXTURE_TX_HASH);
  });
});
