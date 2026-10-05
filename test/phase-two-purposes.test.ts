// Consistent transactions of every redeemer purpose through both phases:
// checkTransaction, then scalus, then the ExUnits and is_valid comparison.
// Each must pass with no failure, and every script must run at the index the
// ledger gives its redeemer (Conway UTxO.hs getConwayScriptsNeeded).
import { blake2b } from '@noble/hashes/blake2.js';
import { describe, expect, it } from 'vitest';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { encodeOutput, type Utxo } from '../src/core/ledger.js';
import { renderFailure } from '../src/host/checks/failure.js';
import { checkTransaction } from '../src/host/checks/index.js';
import { evaluateScripts, phaseTwoFailures } from '../src/host/checks/phase-two.js';
import { languageViews } from '../src/host/checks/script-integrity.js';
import { DEFAULT_COST_MODELS } from '../src/host/cost-models.js';
import { outpoints } from './helpers/build-tx.js';
import { checkContext } from './helpers/check-context.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { inlineDatum, lockedUtxo, myWallet, scriptWitnesses, UNIT_DATA, withVKeys } from './helpers/plutus-spend.js';
import { syntheticInput } from './helpers/synthetic.js';

const { me, myAddress, wallet } = myWallet('purposes-wallet');
const V3 = plutusScript('v3_always_succeeds');
const V2 = plutusScript('v2_always_succeeds');
const EX_UNITS = [100_000n, 10_000_000n];

/** Alonzo Tx.hs hashScriptIntegrity over redeemers written by encode(), no witness datums. */
const integrityHash = (redeemers: unknown[], languages: Set<1 | 2 | 3>) =>
  blake2b(concat(encode(redeemers as never), languageViews(languages, DEFAULT_COST_MODELS)), { dkLen: 32 });

/** Both phases as CheckedLedger runs them. Phase 1 must be empty for phase 2 to run. */
async function judge(txHex: string, unspent: Utxo[]) {
  const ctx = checkContext(txHex, unspent);
  const { failures, unsupported, needs } = checkTransaction(ctx);
  expect(unsupported).toEqual([]);
  expect(failures.map(renderFailure)).toEqual([]);
  const outcome = await evaluateScripts(ctx, needs);
  expect(phaseTwoFailures(ctx, needs, outcome).map(renderFailure)).toEqual([]);
  expect(outcome.kind).toBe('passed');
  const runs = outcome.kind === 'passed' ? outcome.runs.map((r) => [r.tag, r.index]) : [];
  return { needs, runs };
}

describe('every redeemer purpose passes both phases', () => {
  it('a V3 spend whose script sits on a reference input', async () => {
    const locked = lockedUtxo(V3, 'purposes-ref-locked');
    const holder: Utxo = { input: syntheticInput('purposes-ref-holder', 0n), address: myAddress, lovelace: 20_000_000n, scriptRef: encode([3n, V3.bytes] as never) };
    const { witnessSet, scriptDataHash } = scriptWitnesses([{ utxo: locked, script: V3 }], [wallet, locked]);
    // The script comes from the reference input, the witness set carries none.
    witnessSet.delete(7n);
    const fee = 600_000n;
    const tx = withVKeys(
      {
        inputs: [wallet.input, locked.input],
        outputs: [{ address: myAddress, lovelace: wallet.lovelace + locked.lovelace - fee }],
        fee,
        extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(wallet)], [11n, scriptDataHash], [18n, outpoints(holder)]]),
        witnessSet,
      },
      [me.payment],
    );
    const { needs, runs } = await judge(tx, [wallet, locked, holder]);
    expect(runs).toEqual([[0n, needs[0]!.index]]);
  });

  it('a V2 spend of an output with an inline datum', async () => {
    const locked = lockedUtxo(V2, 'purposes-v2-inline', inlineDatum(UNIT_DATA));
    const { witnessSet, scriptDataHash } = scriptWitnesses([{ utxo: locked, script: V2 }], [wallet, locked]);
    const fee = 600_000n;
    const tx = withVKeys(
      {
        inputs: [wallet.input, locked.input],
        outputs: [{ address: myAddress, lovelace: wallet.lovelace + locked.lovelace - fee }],
        fee,
        extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(wallet)], [11n, scriptDataHash]]),
        witnessSet,
      },
      [me.payment],
    );
    const { needs, runs } = await judge(tx, [wallet, locked]);
    expect(runs).toEqual([[0n, needs[0]!.index]]);
  });

  it('a mint under a V3 and a V2 policy, redeemers in policy id order, language views V2 and V3', async () => {
    const name = '74657374';
    const policies = [V3, V2].sort((x, y) => (x.hashHex < y.hashHex ? -1 : 1));
    const mint = new Map(policies.map((p) => [p.hash, new Map([[hexToBytes(name), 1n]])]));
    const redeemers = policies.map((_, i) => [1n, BigInt(i), UNIT_DATA, EX_UNITS]);
    const fee = 2_000_000n;
    const assets = new Map(policies.map((p) => [p.hashHex, new Map([[name, 1n]])]));
    const output = encodeOutput({ input: wallet.input, address: myAddress, lovelace: wallet.lovelace - fee, assets });
    const tx = withVKeys(
      {
        inputs: [wallet.input],
        outputs: [],
        fee,
        extraBodyEntries: new Map<bigint, unknown>([[1n, [output]], [9n, mint], [13n, outpoints(wallet)], [11n, integrityHash(redeemers, new Set([2, 3]))]]),
        witnessSet: new Map<bigint, unknown>([[7n, [V3.bytes]], [6n, [V2.bytes]], [5n, redeemers]]),
      },
      [me.payment],
    );
    const { needs, runs } = await judge(tx, [wallet]);
    expect(needs.map((n) => [n.purpose, n.language])).toEqual(policies.map((p, i) => [`ConwayMinting (AsIx ${i})`, p.language]));
    expect(runs).toEqual([[1n, 0n], [1n, 1n]]);
  });

  // The script account comes first in the ledger's order (ScriptHashObj before KeyHashObj) and last in
  // the CBOR map, where e0 sorts before f0. The redeemer points at index 0.
  it('a script withdrawal next to a key withdrawal, where ledger order and CBOR order differ', async () => {
    const scriptAccount = concat(Uint8Array.of(0xf0), V3.hash);
    const keyAccount = concat(Uint8Array.of(0xe0), keyHash(publicKey(me.stake)));
    const redeemers = [[3n, 0n, UNIT_DATA, EX_UNITS]];
    const fee = 600_000n;
    const tx = withVKeys(
      {
        inputs: [wallet.input],
        outputs: [{ address: myAddress, lovelace: wallet.lovelace - fee }],
        fee,
        withdrawals: [
          { rewardAddress: keyAccount, lovelace: 0n },
          { rewardAddress: scriptAccount, lovelace: 0n },
        ],
        extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(wallet)], [11n, integrityHash(redeemers, new Set([3]))]]),
        witnessSet: new Map<bigint, unknown>([[7n, [V3.bytes]], [5n, redeemers]]),
      },
      [me.payment, me.stake],
    );
    const { needs, runs } = await judge(tx, [wallet]);
    expect(needs.map((n) => n.purpose)).toEqual(['ConwayRewarding (AsIx 0)']);
    expect(runs).toEqual([[3n, 0n]]);
  });

  it('two spends in one transaction, a V3 and a V2 script', async () => {
    const lockedV3 = lockedUtxo(V3, 'purposes-mixed-v3');
    const lockedV2 = lockedUtxo(V2, 'purposes-mixed-v2', inlineDatum(UNIT_DATA));
    const { witnessSet, scriptDataHash } = scriptWitnesses(
      [
        { utxo: lockedV3, script: V3 },
        { utxo: lockedV2, script: V2 },
      ],
      [wallet, lockedV3, lockedV2],
    );
    const fee = 800_000n;
    const tx = withVKeys(
      {
        inputs: [wallet.input, lockedV3.input, lockedV2.input],
        outputs: [{ address: myAddress, lovelace: wallet.lovelace + lockedV3.lovelace + lockedV2.lovelace - fee }],
        fee,
        extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(wallet)], [11n, scriptDataHash]]),
        witnessSet,
      },
      [me.payment],
    );
    const { needs, runs } = await judge(tx, [wallet, lockedV3, lockedV2]);
    expect(needs).toHaveLength(2);
    expect(new Set(needs.map((n) => n.language))).toEqual(new Set([2, 3]));
    expect(runs).toEqual(needs.map((n) => [0n, n.index]).sort((a, b) => Number(a[1]! - b[1]!)));
  });

  // A DRep script (voter type 3) comes before a DRep key (type 2) in the ledger's order and after it in
  // the CBOR map. The redeemer points at index 0.
  it('a vote by a V3 script DRep next to a key DRep, where ledger order and CBOR order differ', async () => {
    const govAction = [blake2b(new TextEncoder().encode('purposes-gov-action'), { dkLen: 32 }), 0n];
    // Both vote yes without an anchor.
    const vote = new Map([[govAction, [1n, null]]]);
    const voters = new Map([
      [[2n, keyHash(publicKey(me.drep))], vote],
      [[3n, V3.hash], vote],
    ]);
    const redeemers = [[4n, 0n, UNIT_DATA, EX_UNITS]];
    const fee = 600_000n;
    const tx = withVKeys(
      {
        inputs: [wallet.input],
        outputs: [{ address: myAddress, lovelace: wallet.lovelace - fee }],
        fee,
        extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(wallet)], [19n, voters], [11n, integrityHash(redeemers, new Set([3]))]]),
        witnessSet: new Map<bigint, unknown>([[7n, [V3.bytes]], [5n, redeemers]]),
      },
      [me.payment, me.drep],
    );
    const { needs, runs } = await judge(tx, [wallet]);
    expect(needs.map((n) => [n.purpose, bytesToHex(n.scriptHash)])).toEqual([['ConwayVoting (AsIx 0)', V3.hashHex]]);
    expect(runs).toEqual([[4n, 0n]]);
  });
});
