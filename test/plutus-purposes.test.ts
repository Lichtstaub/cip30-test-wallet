import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Credential, Data, InlineDatum, PlutusV3, ScriptHash, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import type { TxInput } from '../src/core/cbor/tx.js';
import type { Utxo } from '../src/core/ledger.js';
import { scriptHash } from '../src/core/scripts.js';
import type { CheckContext } from '../src/host/checks/context.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { redeemerFailures } from '../src/host/checks/plutus-rules.js';
import { buildTx, spliceWitnessSet, TEST_ADDRESS } from './helpers/build-tx.js';
import { checkContext } from './helpers/check-context.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { hash28, scriptAddress, syntheticInput } from './helpers/synthetic.js';

const ALWAYS = plutusScript('v3_always_succeeds');
const V2 = plutusScript('v2_always_succeeds');
const V1 = plutusScript('v1_always_succeeds');
const ALWAYS_HASH = ALWAYS.hash;
const plutus = new PlutusV3.PlutusV3({ bytes: ALWAYS.bytes });

const own: Utxo = { input: syntheticInput('purposes-own', 0n), address: TEST_ADDRESS, lovelace: 50_000_000n };
const inlineOne = { kind: 'inline' as const, cbor: hexToBytes('01') };
const lockedAt = (input: TxInput, hash: Uint8Array = ALWAYS_HASH): Utxo => ({ input, address: scriptAddress(hash), lovelace: 5_000_000n, datum: inlineOne });
/** Witness set keys 3, 6 and 7 with the V1, V2 and V3 fixture scripts. */
const allPlutus = (): Array<[bigint, unknown]> => [[3n, [V1.bytes]], [6n, [V2.bytes]], [7n, [ALWAYS.bytes]]];
const redeemerMap = (...pointers: Array<[bigint, bigint]>) => new Map(pointers.map(([tag, index]) => [[tag, index], [0n, [1n, 1n]]]));
const anchor = ['https://example.com/a.json', new Uint8Array(32)];

const pointers = (ctx: CheckContext) => plutusNeeds(ctx).map((n) => [n.tag, n.index, bytesToHex(n.scriptHash)]);
const redeemerRules = (ctx: CheckContext) => redeemerFailures(ctx, plutusNeeds(ctx));

interface HandTx {
  inputs?: Utxo[];
  body?: Array<[bigint, unknown]>;
  witnesses?: Array<[bigint, unknown]>;
}
const handTx = (opts: HandTx) =>
  buildTx({ inputs: (opts.inputs ?? [own]).map((u) => u.input), outputs: [], fee: 200_000n, extraBodyEntries: new Map(opts.body ?? []), witnessSet: new Map(opts.witnesses ?? []) });

describe('plutusNeeds: spend', () => {
  const high = lockedAt({ txId: new Uint8Array(32).fill(0xee), index: 0n });
  const low = lockedAt({ txId: new Uint8Array(32).fill(0x01), index: 1n });
  const lowZero = lockedAt({ txId: new Uint8Array(32).fill(0x01), index: 0n });
  const evo = (u: Utxo) =>
    new UTxO.UTxO({
      transactionId: TransactionHash.fromBytes(u.input.txId),
      index: u.input.index,
      address: new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(plutus) }),
      assets: Assets.fromLovelace(5_000_000n),
      datumOption: new InlineDatum.InlineDatum({ data: Data.int(1n) }),
    });

  it('counts the set of all spend inputs, the redeemers of an Evolution spend stay valid in unsorted wire order', async () => {
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [evo(high)], redeemer: Data.int(7n) }).collectFrom({ inputs: [evo(low)], redeemer: Data.int(8n) }).attachScript({ script: plutus }),
      TEST_ADDRESS,
      [evolutionUtxo(own, TEST_ADDRESS)],
      { evaluator: fixedBudgetEvaluator },
    );
    const utxos = [own, high, low];
    const sorted = checkContext(tx, utxos);
    // The two script inputs pay the fee, the wallet UTxO serves as collateral only.
    expect(sorted.parsed.body.inputs.map((i) => bytesToHex(i.txId).slice(0, 2))).toEqual(['01', 'ee']);
    const expected = [
      [0n, 0n, ALWAYS.hashHex],
      [0n, 1n, ALWAYS.hashHex],
    ];
    expect(pointers(sorted)).toEqual(expected);
    expect(redeemerRules(sorted)).toEqual([]);
    // The low input carries redeemer 8, the high one 7. Evolution writes the map in collectFrom order.
    expect(sorted.facts.redeemerData.map((r) => [r.tag, r.index, bytesToHex(r.data)])).toEqual([
      [0n, 1n, '07'],
      [0n, 0n, '08'],
    ]);

    // The same witness set behind a body that lists the high input first, as a plain array.
    const witnessSet = CSL.Transaction.from_hex(tx).witness_set().to_hex();
    const unsorted = spliceWitnessSet(buildTx({ inputs: [high.input, low.input], outputs: [], fee: 200_000n, plainArraySets: true }), witnessSet);
    const ctx = checkContext(unsorted, utxos);
    expect(ctx.parsed.body.inputs.map((i) => bytesToHex(i.txId).slice(0, 2))).toEqual(['ee', '01']);
    expect(pointers(ctx)).toEqual(expected);
    expect(redeemerRules(ctx)).toEqual([]);
  });

  it('orders two outputs of one transaction by index and keeps the spend input and its UTxO', () => {
    const ctx = checkContext(handTx({ inputs: [low, lowZero], witnesses: [[7n, [ALWAYS.bytes]]] }), [low, lowZero]);
    const needs = plutusNeeds(ctx);
    expect(needs.map((n) => [n.index, n.spend?.input.index])).toEqual([
      [0n, 0n],
      [1n, 1n],
    ]);
    expect(needs[1]).toEqual({ tag: 0n, index: 1n, scriptHash: ALWAYS_HASH, language: 3, spend: { input: low.input, utxo: low }, purpose: 'ConwaySpending (AsIx 1)' });
  });

  it('needs only a Plutus script that is provided, from the witness set or a reference script', () => {
    const native = [1n, []]; // all [] holds without a signature
    const nativeHash = scriptHash(0, encode(native as never));
    const atNative = lockedAt(syntheticInput('purposes-native', 0n), nativeHash);
    const unprovided = lockedAt(syntheticInput('purposes-unprovided', 0n), hash28(9));
    const viaRef = lockedAt(syntheticInput('purposes-via-ref', 0n), V2.hash);
    const holder: Utxo = { input: syntheticInput('purposes-holder', 0n), address: TEST_ADDRESS, lovelace: 20_000_000n, scriptRef: encode([2n, V2.bytes]) };
    const inputs = [atNative, unprovided, viaRef, own];
    const ctx = checkContext(handTx({ inputs, body: [[18n, new Tagged(258n, [[holder.input.txId, 0n]])]], witnesses: [[1n, [native]]] }), [...inputs, holder]);
    const needs = plutusNeeds(ctx);
    expect(needs.map((n) => [bytesToHex(n.scriptHash), n.language])).toEqual([[V2.hashHex, 2]]);
  });
});

describe('plutusNeeds: reward, where the ledger order differs from the wire order', () => {
  const scriptAccount = concat(Uint8Array.of(0xf0), ALWAYS_HASH);

  it('an Evolution withdrawal pair, key account first on the wire: the script account is reward 0', async () => {
    // Key hash ff..ff: the wire (e0ff.. before f05d..) puts the key account first, the ledger the script account.
    const tx = await evolutionBuild(
      (b) =>
        b
          .withdraw({ stakeCredential: Credential.makeKeyHash(new Uint8Array(28).fill(0xff)), amount: 0n })
          .withdraw({ stakeCredential: Credential.makeScriptHash(ALWAYS_HASH), amount: 0n, redeemer: Data.constr(0n, []) })
          .attachScript({ script: plutus }),
      TEST_ADDRESS,
      [evolutionUtxo(own, TEST_ADDRESS)],
      { evaluator: fixedBudgetEvaluator },
    );
    const ctx = checkContext(tx, [own]);
    expect(ctx.facts.withdrawals.map((w) => bytesToHex(w.rewardAddress).slice(0, 4))).toEqual(['e0ff', 'f05d']);
    expect(pointers(ctx)).toEqual([[3n, 0n, ALWAYS.hashHex]]);
    expect(ctx.facts.redeemers.map((r) => [r.tag, r.index])).toEqual([[3n, 0n]]);
    expect(redeemerRules(ctx)).toEqual([]);
  });

  it('a CSL withdrawal pair whose key hash sorts before the script hash: still the script account is reward 0', () => {
    const script = CSL.PlutusScript.from_bytes_with_version(CSL.PlutusData.new_bytes(ALWAYS.bytes).to_bytes(), CSL.Language.new_plutus_v3());
    const withdrawals = CSL.WithdrawalsBuilder.new();
    withdrawals.add(CSL.RewardAddress.new(0, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28)))), CSL.BigNum.zero());
    const redeemer = CSL.Redeemer.new(CSL.RedeemerTag.new_reward(), CSL.BigNum.zero(), CSL.PlutusData.new_empty_constr_plutus_data(CSL.BigNum.zero()), CSL.ExUnits.new(CSL.BigNum.from_str('1000'), CSL.BigNum.from_str('1000')));
    withdrawals.add_with_plutus_witness(CSL.RewardAddress.new(0, CSL.Credential.from_scripthash(script.hash())), CSL.BigNum.zero(), CSL.PlutusWitness.new_without_datum(script, redeemer));
    const big = (n: number) => CSL.BigNum.from_str(String(n));
    const config = CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(CSL.LinearFee.new(big(44), big(155_381)))
      .pool_deposit(big(500_000_000))
      .key_deposit(big(2_000_000))
      .max_value_size(5000)
      .max_tx_size(16_384)
      .coins_per_utxo_byte(big(4310))
      .ex_unit_prices(CSL.ExUnitPrices.new(CSL.UnitInterval.new(big(577), big(10_000)), CSL.UnitInterval.new(big(721), big(10_000_000))))
      .ref_script_coins_per_byte(CSL.UnitInterval.new(big(15), big(1)))
      .build();
    const builder = CSL.TransactionBuilder.new(config);
    const address = CSL.Address.from_bytes(TEST_ADDRESS);
    builder.add_regular_input(address, CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(own.input.txId), 0), CSL.Value.new(big(50_000_000)));
    builder.set_withdrawals_builder(withdrawals);
    // The hash plays no part here, build_tx only wants the field set.
    builder.set_script_data_hash(CSL.ScriptDataHash.from_bytes(new Uint8Array(32)));
    builder.add_change_if_needed(address);
    const ctx = checkContext(builder.build_tx_unsafe().to_hex(), [own]);
    expect(ctx.facts.withdrawals.map((w) => bytesToHex(w.rewardAddress).slice(0, 4))).toEqual(['f05d', 'e000']);
    expect(pointers(ctx)).toEqual([[3n, 0n, ALWAYS.hashHex]]);
    expect(ctx.facts.redeemers.map((r) => [r.tag, r.index])).toEqual([[3n, 0n]]);
    expect(redeemerRules(ctx)).toEqual([]);
  });

  it('a redeemer at the position of a hash-only order is reported as the node would', () => {
    // Key hash 00..00 sorts before the script hash by bytes, a builder that orders by hash alone puts the script at 1.
    const withdrawals = new Map([
      [concat(Uint8Array.of(0xe0), new Uint8Array(28)), 0n],
      [scriptAccount, 0n],
    ]);
    const ctx = checkContext(handTx({ body: [[5n, withdrawals]], witnesses: [[7n, [ALWAYS.bytes]], [5n, redeemerMap([3n, 1n])]] }), [own]);
    expect(redeemerRules(ctx)).toEqual([
      { path: ['ConwayUtxowFailure'], rule: 'ExtraRedeemers', detail: '[ConwayRewarding (AsIx 1)]' },
      { path: ['ConwayUtxowFailure'], rule: 'MissingRedeemers', detail: `[(ConwayRewarding (AsIx 0), ${ALWAYS.hashHex})]` },
    ]);
  });

  it('puts testnet accounts before mainnet accounts', () => {
    const mainnetScript = concat(Uint8Array.of(0xf1), ALWAYS_HASH);
    const testnetKey = concat(Uint8Array.of(0xe0), hash28(1));
    const ctx = checkContext(handTx({ body: [[5n, new Map([[mainnetScript, 0n], [testnetKey, 0n]])]], witnesses: [[7n, [ALWAYS.bytes]]] }), [own]);
    expect(pointers(ctx)).toEqual([[3n, 1n, ALWAYS.hashHex]]);
  });
});

describe('plutusNeeds: cert, mint, vote, propose', () => {
  const scriptCred = [1n, ALWAYS_HASH];
  const keyCred = [0n, hash28(1)];

  it('counts certificates by position, a registration without deposit and pool certificates need no script', () => {
    const poolRegistration = [3n, hash28(2), new Uint8Array(32), 0n, 0n, new Tagged(30n, [0n, 1n]), concat(Uint8Array.of(0xe0), hash28(3)), [], [], null];
    const certificates = [
      [0n, scriptCred],
      [7n, scriptCred, 2_000_000n],
      poolRegistration,
      [14n, scriptCred, keyCred],
      [9n, keyCred, [2n]],
      [17n, scriptCred, 500_000_000n],
    ];
    const ctx = checkContext(handTx({ body: [[4n, certificates]], witnesses: [[7n, [ALWAYS.bytes]]] }), [own]);
    expect(pointers(ctx)).toEqual([
      [2n, 1n, ALWAYS.hashHex],
      [2n, 3n, ALWAYS.hashHex],
      [2n, 5n, ALWAYS.hashHex],
    ]);
    expect(plutusNeeds(ctx).map((n) => n.purpose)).toEqual(['ConwayCertifying (AsIx 1)', 'ConwayCertifying (AsIx 3)', 'ConwayCertifying (AsIx 5)']);
  });

  it('counts mint policies in byte order, whatever the wire order', () => {
    const mint = new Map([
      [V2.hash, new Map([[hexToBytes('41'), 1n]])],
      [ALWAYS_HASH, new Map([[hexToBytes('41'), 1n]])],
      [V1.hash, new Map([[hexToBytes('41'), 1n]])],
    ]);
    const ctx = checkContext(handTx({ body: [[9n, mint]], witnesses: allPlutus() }), [own]);
    // 5d0f.. (V3), 67f3.. (V1), 793f.. (V2)
    expect(plutusNeeds(ctx).map((n) => [n.tag, n.index, n.language])).toEqual([
      [1n, 0n, 3],
      [1n, 1n, 1],
      [1n, 2n, 2],
    ]);
  });

  it('counts voters committee before DRep before pool, each script before key', () => {
    const vote = new Map([[[new Uint8Array(32), 0n], [1n, null]]]);
    const voters = new Map<unknown, unknown>([
      [[4n, hash28(1)], vote],
      [[2n, hash28(2)], vote],
      [[3n, V2.hash], vote],
      [[0n, hash28(3)], vote],
      [[1n, ALWAYS_HASH], vote],
    ]);
    const ctx = checkContext(handTx({ body: [[19n, voters]], witnesses: allPlutus() }), [own]);
    expect(pointers(ctx)).toEqual([
      [4n, 0n, ALWAYS.hashHex],
      [4n, 2n, V2.hashHex],
    ]);
    expect(plutusNeeds(ctx).map((n) => n.purpose)).toEqual(['ConwayVoting (AsIx 0)', 'ConwayVoting (AsIx 2)']);
  });

  it('counts proposals by position, a guardrail on a parameter change or a treasury withdrawal', () => {
    const account = concat(Uint8Array.of(0xe0), hash28(1));
    const proposals = new Tagged(258n, [
      [100_000_000_000n, account, [6n], anchor],
      [100_000_000_000n, account, [0n, null, new Map([[0n, 44n]]), ALWAYS_HASH], anchor],
      [100_000_000_000n, account, [2n, new Map([[account, 1n]]), ALWAYS_HASH], anchor],
    ]);
    const ctx = checkContext(handTx({ body: [[20n, proposals]], witnesses: [[7n, [ALWAYS.bytes]]] }), [own]);
    expect(pointers(ctx)).toEqual([
      [5n, 1n, ALWAYS.hashHex],
      [5n, 2n, ALWAYS.hashHex],
    ]);
    expect(plutusNeeds(ctx)[0]!.purpose).toBe('ConwayProposing (AsIx 1)');
  });

  it('lists needs spend, reward, cert, mint, vote, propose, whatever the body order', () => {
    const locked = lockedAt(syntheticInput('purposes-all', 0n));
    const body: Array<[bigint, unknown]> = [
      [20n, [[100_000_000_000n, concat(Uint8Array.of(0xe0), hash28(1)), [2n, new Map(), ALWAYS_HASH], anchor]]],
      [19n, new Map([[[3n, ALWAYS_HASH], new Map([[[new Uint8Array(32), 0n], [1n, null]]])]])],
      [9n, new Map([[ALWAYS_HASH, new Map([[hexToBytes('41'), 1n]])]])],
      [4n, [[8n, scriptCred, 2_000_000n]]],
      [5n, new Map([[concat(Uint8Array.of(0xf0), ALWAYS_HASH), 0n]])],
    ];
    const ctx = checkContext(handTx({ inputs: [locked], body, witnesses: [[7n, [ALWAYS.bytes]]] }), [locked]);
    expect(plutusNeeds(ctx).map((n) => n.purpose)).toEqual([
      'ConwaySpending (AsIx 0)',
      'ConwayRewarding (AsIx 0)',
      'ConwayCertifying (AsIx 0)',
      'ConwayMinting (AsIx 0)',
      'ConwayVoting (AsIx 0)',
      'ConwayProposing (AsIx 0)',
    ]);
  });
});
