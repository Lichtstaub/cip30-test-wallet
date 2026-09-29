import { describe, expect, it } from 'vitest';
import { Tagged } from '../src/core/cbor/decode.js';
import { baseAddressBytes } from '../src/core/addresses.js';
import { APIErrorCode, ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { MemoryLedger, type Utxo } from '../src/core/ledger.js';
import { parseTxHex, signTx as signParsed, signWithKeys, type SignContext } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { buildTx, spliceWitnessSet, witnessVkeys } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const other = deriveAccount(MNEMONIC, 1);
const myAddress = baseAddressBytes(0, keyHash(publicKey(me.payment)), keyHash(publicKey(me.stake)));
const otherAddress = baseAddressBytes(0, keyHash(publicKey(other.payment)), keyHash(publicKey(other.stake)));
const mine: Utxo = { input: syntheticInput('c-mine', 0n), address: myAddress, lovelace: 10_000_000n };
const myCollateral: Utxo = { input: syntheticInput('c-col', 0n), address: myAddress, lovelace: 5_000_000n };
const theirCollateral: Utxo = { input: syntheticInput('c-theirs', 0n), address: otherAddress, lovelace: 5_000_000n };

const ctx = (foreign: Utxo[] = []): SignContext => ({ payment: me.payment, stake: me.stake, ledger: new MemoryLedger({ owned: [mine, myCollateral], foreign }) });
const sign = (tx: string, partial: boolean, c = ctx()) => signParsed(parseTxHex(tx).parsed, partial, c);
const withCollateral = (col: Utxo) =>
  buildTx({
    inputs: [mine.input],
    outputs: [{ address: myAddress, lovelace: 9_000_000n }],
    fee: 200_000n,
    extraBodyEntries: new Map<bigint, unknown>([
      [13n, new Tagged(258n, [[col.input.txId, col.input.index]])],
      [16n, [myAddress, 4_700_000n]],
      [17n, 300_000n],
    ]),
  });

describe('collateral fields', () => {
  it('signs a key spend with an own collateral input, return and total, one payment witness', async () => {
    for (const partial of [false, true]) {
      expect(witnessVkeys(await sign(withCollateral(myCollateral), partial))).toHaveLength(1);
    }
  });

  it('a foreign collateral input is ProofGeneration uncovered, passes covered', async () => {
    const tx = withCollateral(theirCollateral);
    await expect(sign(tx, false, ctx([theirCollateral]))).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
    expect(witnessVkeys(await sign(tx, true, ctx([theirCollateral])))).toHaveLength(1);
    const covered = spliceWitnessSet(tx, signWithKeys(tx, [other.payment]));
    expect(witnessVkeys(await sign(covered, false, ctx([theirCollateral])))).toHaveLength(1);
  });

  it('an unknown collateral input is CHW_UNRESOLVED_INPUT at both partialSign values', async () => {
    const unknown: Utxo = { input: syntheticInput('c-unknown', 0n), address: myAddress, lovelace: 1n };
    for (const partial of [false, true]) {
      const caught = await sign(withCollateral(unknown), partial).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(ChwError);
      expect((caught as ChwError).code).toBe('CHW_UNRESOLVED_INPUT');
    }
  });

  it('names a collateral input as such in its requirement', async () => {
    const { requirements } = await import('../src/core/requirements.js');
    const { parsed } = parseTxHex(withCollateral(myCollateral));
    const reqs = requirements(parsed.body, [mine, myCollateral]);
    expect(reqs.keys[1]!.source).toMatch(/^collateral input [0-9a-f]{64}#0$/);
  });

  it('rejects an empty collateral set, a malformed collateral return and total', () => {
    const bad = (key: bigint, value: unknown) => () =>
      parseTxHex(buildTx({ inputs: [mine.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[key, value]]) }));
    for (const [key, value] of [[13n, []], [16n, 5n], [17n, 'x']] as const) {
      expect(bad(key, value)).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });

  it('parses collateral inputs as a plain array and as tag 258', () => {
    const plain = buildTx({ inputs: [mine.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[13n, [[myCollateral.input.txId, 0n]]]]) });
    expect(parseTxHex(plain).parsed.body.collateralInputs).toHaveLength(1);
    expect(parseTxHex(withCollateral(myCollateral)).parsed.body.collateralInputs).toHaveLength(1);
  });
});
