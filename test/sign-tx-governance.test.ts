import { describe, expect, it } from 'vitest';
import { TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import { bytesToHex } from '../src/core/bytes.js';
import { baseAddressBytes, rewardAddressBytes } from '../src/core/addresses.js';
import { ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { MemoryLedger, type Utxo } from '../src/core/ledger.js';
import { parseTxHex, signTx as signParsed, signWithKeys, type SignContext } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { buildTx, spliceWitnessSet } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const pool = deriveAccount(MNEMONIC, 2);
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const myDrep = keyHash(publicKey(me.drep));
const poolKey = keyHash(publicKey(pool.payment));
const mine: Utxo = { input: syntheticInput('gov-mine', 0n), address: baseAddressBytes(0, myPay, myStake), lovelace: 10_000_000n };
const anchor = ['https://example.com/a.json', new Uint8Array(32)];
const govActionId = [new Uint8Array(32).fill(3), 0n];

const ctx = (drep = true): SignContext => ({
  payment: me.payment,
  stake: me.stake,
  ...(drep ? { drep: me.drep } : {}),
  ledger: new MemoryLedger({ owned: [mine] }),
});
const tx = (entries: Array<[bigint, unknown]>) =>
  buildTx({ inputs: [mine.input], outputs: [{ address: mine.address, lovelace: 9_000_000n }], fee: 200_000n, extraBodyEntries: new Map(entries) });
const sign = (txHex: string, partial: boolean, context = ctx()) => signParsed(parseTxHex(txHex).parsed, partial, context);
const signers = (wsHex: string) => (TransactionWitnessSet.fromCBORHex(wsHex).toJSON().vkeyWitnesses ?? []).length;
// Evolution's toJSON() gives a VKey object, not a hex string, see test/witness.test.ts:44.
const vkeysOf = (wsHex: string) => (TransactionWitnessSet.fromCBORHex(wsHex).toJSON().vkeyWitnesses ?? []).map((w) => VKey.toHex(w.vkey));
const pub = (k: typeof me.payment) => bytesToHex(publicKey(k));
const other = deriveAccount(MNEMONIC, 3);
const otherStake = keyHash(publicKey(other.stake));
const otherDrep = keyHash(publicKey(other.drep));

describe('signTx over governance forms', () => {
  it('vote delegation: payment and stake key, nothing else', async () => {
    const ws = await sign(tx([[4n, [[9n, [0n, myStake], [0n, myDrep]]]]]), false);
    expect(vkeysOf(ws).sort()).toEqual([pub(me.payment), pub(me.stake)].sort());
  });

  it('DRep update and a vote by the own DRep: payment and DRep key, one DRep witness only', async () => {
    const votes = new Map([[[2n, myDrep], new Map([[govActionId, [1n, null]]])]]);
    const ws = await sign(tx([[4n, [[18n, [0n, myDrep], anchor]]], [19n, votes]]), false);
    expect(vkeysOf(ws).sort()).toEqual([pub(me.payment), pub(me.drep)].sort());
  });

  it('stake key as withdrawal and as certificate: one stake witness only', async () => {
    const ws = await sign(
      buildTx({
        inputs: [mine.input],
        outputs: [],
        fee: 1n,
        withdrawals: [{ rewardAddress: rewardAddressBytes(0, myStake), lovelace: 1n }],
        extraBodyEntries: new Map([[4n, [[1n, [0n, myStake]]]]]),
      }),
      false,
    );
    expect(signers(ws)).toBe(2);
  });

  it('registration without deposit (0) needs no stake witness at both partialSign values, "covered" does not apply', async () => {
    for (const partial of [false, true]) {
      expect(vkeysOf(await sign(tx([[4n, [[0n, [0n, myStake]]]]]), partial))).toEqual([pub(me.payment)]);
    }
  });

  it('an unknown certificate index is CHW_UNSUPPORTED_TX_FORM at partialSign false, skipped at true', async () => {
    const t = tx([[4n, [[42n, [0n, myStake]]]]]);
    await expect(sign(t, false)).rejects.toThrow(/CHW_UNSUPPORTED_TX_FORM: certificate 42/);
    expect(vkeysOf(await sign(t, true))).toEqual([pub(me.payment)]);
  });

  it('a proposal without guardrail, treasury value and donation need only the input witness', async () => {
    const proposal = [100_000_000_000n, rewardAddressBytes(0, myStake), [6n], anchor];
    expect(signers(await sign(tx([[20n, [proposal]], [21n, 1n], [22n, 5n]]), false))).toBe(1);
  });

  it('pool registration with the wallet stake key as owner: never signed as owner (CIP-95)', async () => {
    const params = [poolKey, new Uint8Array(32), 1n, 340_000_000n, [0n, 1n], rewardAddressBytes(0, myStake), [myStake], [], null];
    const t = tx([[4n, [[3n, ...params]]]]);
    await expect(sign(t, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
    expect(vkeysOf(await sign(t, true))).toEqual([pub(me.payment)]);
  });

  it('pool registration already signed by operator and owner passes, the wallet adds only its payment witness', async () => {
    const params = [poolKey, new Uint8Array(32), 1n, 340_000_000n, [0n, 1n], rewardAddressBytes(0, otherStake), [otherStake], [], null];
    const unsigned = tx([[4n, [[3n, ...params]]]]);
    const withForeign = spliceWitnessSet(unsigned, signWithKeys(unsigned, [pool.payment, other.stake]));
    expect(vkeysOf(await sign(withForeign, false))).toEqual([pub(me.payment)]);
  });

  it('a vote by a committee member or a pool is foreign: ProofGeneration uncovered, passes covered', async () => {
    for (const type of [0n, 4n]) {
      const votes = new Map([[[type, keyHash(publicKey(pool.payment))], new Map([[govActionId, [1n, null]]])]]);
      const unsigned = tx([[19n, votes]]);
      await expect(sign(unsigned, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
      expect(vkeysOf(await sign(unsigned, true))).toEqual([pub(me.payment)]);
      const covered = spliceWitnessSet(unsigned, signWithKeys(unsigned, [pool.payment]));
      expect(vkeysOf(await sign(covered, false))).toEqual([pub(me.payment)]);
    }
  });

  it('without a DRep key (noCip95) a DRep vote is foreign', async () => {
    const votes = new Map([[[2n, myDrep], new Map([[govActionId, [1n, null]]])]]);
    await expect(sign(tx([[19n, votes]]), false, ctx(false))).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
    expect(vkeysOf(await sign(tx([[19n, votes]]), true, ctx(false)))).toEqual([pub(me.payment)]);
  });

  it('a deprecated certificate is code 3 at both partialSign values', async () => {
    for (const partial of [false, true]) {
      await expect(sign(tx([[4n, [[6n, 'anything']]]]), partial)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.DeprecatedCertificate }));
    }
  });

  it('a script credential in a certificate is CHW_UNSUPPORTED_TX_FORM at partialSign false, skipped at true', async () => {
    const t = tx([[4n, [[9n, [1n, myStake], [0n, myDrep]]]]]);
    await expect(sign(t, false)).rejects.toBeInstanceOf(ChwError);
    await expect(sign(t, false)).rejects.toThrow(/delegation_to_drep\) with a script credential/);
    expect(signers(await sign(t, true))).toBe(1);
  });

  it('a proposal with a guardrail script is CHW_UNSUPPORTED_TX_FORM at partialSign false', async () => {
    const guarded = [100n, rewardAddressBytes(0, myStake), [2n, new Map([[rewardAddressBytes(0, myStake), 5n]]), new Uint8Array(28).fill(9)], anchor];
    await expect(sign(tx([[20n, [guarded]]]), false)).rejects.toThrow(/guardrail script/);
  });
});

// Exit criterion 2 of the spec: every row of the witness table, both partialSign
// values, own, foreign uncovered and foreign covered. Row 0 is tested above, it has
// no witness, so "covered" does not apply. Rows 3, 4, 14 and 15 are foreignOnly,
// their matrix runs against CSL-built certificates in test/governance-oracle.test.ts.
const POOL = new Uint8Array(28).fill(7);
function certFor(index: bigint, credential: Uint8Array): unknown[] {
  const cred = [0n, credential];
  switch (index) {
    case 1n: return [1n, cred];
    case 2n: return [2n, cred, POOL];
    case 7n: return [7n, cred, 2_000_000n];
    case 8n: return [8n, cred, 2_000_000n];
    case 9n: return [9n, cred, [0n, myDrep]];
    case 10n: return [10n, cred, POOL, [0n, myDrep]];
    case 11n: return [11n, cred, POOL, 2_000_000n];
    case 12n: return [12n, cred, [0n, myDrep], 2_000_000n];
    case 13n: return [13n, cred, POOL, [0n, myDrep], 2_000_000n];
    case 16n: return [16n, cred, 500_000_000n, null];
    case 17n: return [17n, cred, 500_000_000n];
    case 18n: return [18n, cred, null];
    default: throw new Error(`no fixture for certificate ${index}`);
  }
}
const STAKE_ROWS = [1n, 2n, 7n, 8n, 9n, 10n, 11n, 12n, 13n];
const DREP_ROWS = [16n, 17n, 18n];

describe('witness table matrix', () => {
  it.each([...STAKE_ROWS.map((i) => [i, 'stake'] as const), ...DREP_ROWS.map((i) => [i, 'drep'] as const)])(
    'certificate %s (%s credential)',
    async (index, kind) => {
      const own = kind === 'stake' ? myStake : myDrep;
      const foreign = kind === 'stake' ? otherStake : otherDrep;
      const foreignKey = kind === 'stake' ? other.stake : other.drep;
      const ownKey = kind === 'stake' ? me.stake : me.drep;

      // own credential: signed with that role at both partialSign values
      for (const partial of [false, true]) {
        expect(vkeysOf(await sign(tx([[4n, [certFor(index, own)]]]), partial)).sort()).toEqual([pub(me.payment), pub(ownKey)].sort());
      }

      // foreign credential, uncovered: ProofGeneration at false, payment only at true
      const unsigned = tx([[4n, [certFor(index, foreign)]]]);
      await expect(sign(unsigned, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
      expect(vkeysOf(await sign(unsigned, true))).toEqual([pub(me.payment)]);

      // foreign credential, covered by a valid witness: payment only at both values
      const covered = spliceWitnessSet(unsigned, signWithKeys(unsigned, [foreignKey]));
      for (const partial of [false, true]) {
        expect(vkeysOf(await sign(covered, partial))).toEqual([pub(me.payment)]);
      }

      // foreign credential, "covered" by a witness with a broken signature: still ProofGeneration
      const good = signWithKeys(unsigned, [foreignKey]);
      const broken = spliceWitnessSet(unsigned, good.slice(0, -2) + (good.endsWith('00') ? '01' : '00'));
      await expect(sign(broken, false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
    },
  );
});
