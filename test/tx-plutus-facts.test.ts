import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Data, InlineDatum, PlutusV3, ScriptHash, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { readTransaction } from '../src/host/checks/read-tx.js';
import { buildTx, spliceWitnessSet, TEST_ADDRESS } from './helpers/build-tx.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { plutusScript, type PlutusFixture } from './helpers/plutus-fixtures.js';
import { syntheticInput } from './helpers/synthetic.js';

const ALWAYS = plutusScript('v3_always_succeeds');
const V1 = plutusScript('v1_always_succeeds');
const V2 = plutusScript('v2_always_succeeds');

const input = syntheticInput('plutus-facts', 0n);
const factsOf = (tx: string | Uint8Array) => {
  const bytes = typeof tx === 'string' ? hexToBytes(tx) : tx;
  return readTransaction(bytes, parseTransaction(bytes));
};
/** A one input transaction whose witness set is exactly these bytes, so a test controls every encoding detail. */
const withWitnessSet = (witnessSetHex: string, body: Array<[bigint, unknown]> = []) =>
  spliceWitnessSet(buildTx({ inputs: [input], outputs: [{ address: TEST_ADDRESS, lovelace: 2_000_000n }], fee: 200_000n, extraBodyEntries: new Map(body) }), witnessSetHex);
const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const blake256 = (hex: string) => blake2b(hexToBytes(hex), { dkLen: 32 });
/** The CBOR byte string around a script, the form CSL's from_bytes_with_version reads. */
const cslScript = (s: PlutusFixture, language: CSL.Language) => CSL.PlutusScript.from_bytes_with_version(CSL.PlutusData.new_bytes(s.bytes).to_bytes(), language);

/**
 * A spend of a script UTxO with a datum hash, the datum in the witness set and
 * one spend redeemer, built by CSL the way a V1 or V2 dApp does it.
 */
function cslDatumHashSpend(script: CSL.PlutusScript) {
  const datum = CSL.PlutusData.new_integer(CSL.BigInt.from_str('42'));
  const redeemer = CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(0), CSL.PlutusData.new_empty_constr_plutus_data(big(0)), CSL.ExUnits.new(big(100_000), big(10_000_000)));
  const inputs = CSL.TransactionInputs.new();
  inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
  const outputs = CSL.TransactionOutputs.new();
  outputs.add(CSL.TransactionOutput.new(CSL.Address.from_bytes(TEST_ADDRESS), CSL.Value.new(big(4_600_000))));
  const body = CSL.TransactionBody.new_tx_body(inputs, outputs, big(400_000));
  const witnesses = CSL.TransactionWitnessSet.new();
  const scripts = CSL.PlutusScripts.new();
  scripts.add(script);
  witnesses.set_plutus_scripts(scripts);
  const datums = CSL.PlutusList.new();
  datums.add(datum);
  witnesses.set_plutus_data(datums);
  const redeemers = CSL.Redeemers.new();
  redeemers.add(redeemer);
  witnesses.set_redeemers(redeemers);
  const costModels = CSL.Costmdls.new();
  body.set_script_data_hash(CSL.hash_script_data(redeemers, costModels, datums));
  return { tx: CSL.Transaction.new(body, witnesses), datum, redeemer };
}

describe('readTransaction: Plutus scripts, redeemer data, datums and the script data hash', () => {
  it.each([
    ['V1', V1, CSL.Language.new_plutus_v1(), 1],
    ['V2', V2, CSL.Language.new_plutus_v2(), 2],
  ] as const)('reads a Plutus %s spend with a datum hash and a witness datum that CSL built', (_name, fixture, language, tag) => {
    const script = cslScript(fixture, language);
    expect(script.hash().to_hex()).toBe(fixture.hashHex);
    const { tx, datum, redeemer } = cslDatumHashSpend(script);
    const facts = factsOf(tx.to_bytes());
    expect(facts.plutusScripts).toEqual([{ language: tag, hash: fixture.hash, bytes: fixture.bytes }]);
    expect(facts.datums).toEqual([{ hash: CSL.hash_plutus_data(datum).to_bytes(), bytes: datum.to_bytes() }]);
    // CSL writes the datums as tag 258 around an indefinite list, the set form of the Conway CDDL.
    expect(bytesToHex(facts.datumsBytes!)).toBe('d90102' + tx.witness_set().plutus_data()!.to_hex());
    expect(tx.witness_set().plutus_data()!.to_hex().startsWith('9f')).toBe(true);
    expect(facts.redeemers).toEqual([{ tag: 0n, index: 0n, mem: 100_000n, steps: 10_000_000n }]);
    expect(facts.redeemerData).toEqual([{ tag: 0n, index: 0n, data: redeemer.data().to_bytes() }]);
    expect(facts.redeemersBytes).toEqual(tx.witness_set().redeemers()!.to_bytes());
    expect(facts.scriptDataHash).toEqual(tx.body().script_data_hash()!.to_bytes());
  });

  it('reads a Plutus V3 spend with an inline datum that Evolution built', async () => {
    const plutus = new PlutusV3.PlutusV3({ bytes: ALWAYS.bytes });
    expect(ScriptHash.toHex(ScriptHash.fromScript(plutus))).toBe(ALWAYS.hashHex);
    const lockedInput = syntheticInput('plutus-facts-locked', 0n);
    const locked = new UTxO.UTxO({
      transactionId: TransactionHash.fromBytes(lockedInput.txId),
      index: 0n,
      address: new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(plutus) }),
      assets: Assets.fromLovelace(5_000_000n),
      datumOption: new InlineDatum.InlineDatum({ data: Data.int(1n) }),
    });
    const own = { input, address: TEST_ADDRESS, lovelace: 50_000_000n };
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [locked], redeemer: Data.int(7n) }).attachScript({ script: plutus }),
      TEST_ADDRESS,
      [evolutionUtxo(own, TEST_ADDRESS)],
      { evaluator: fixedBudgetEvaluator },
    );
    const csl = CSL.Transaction.from_hex(tx);
    const facts = factsOf(tx);
    expect(facts.plutusScripts).toEqual([{ language: 3, hash: ALWAYS.hash, bytes: ALWAYS.bytes }]);
    expect(facts.datums).toEqual([]);
    expect(facts.datumsBytes).toBeUndefined();
    // Evolution writes the Conway map form.
    expect(bytesToHex(facts.redeemersBytes!).startsWith('a1')).toBe(true);
    expect(facts.redeemersBytes).toEqual(csl.witness_set().redeemers()!.to_bytes());
    expect(facts.redeemerData).toEqual([{ tag: 0n, index: 0n, data: Data.toCBORBytes(Data.int(7n)) }]);
    expect(facts.scriptDataHash).toEqual(csl.body().script_data_hash()!.to_bytes());
  });

  it('leaves every Plutus field empty when the transaction carries none', () => {
    expect(factsOf(withWitnessSet('a0'))).toMatchObject({
      plutusScripts: [],
      redeemerData: [],
      redeemersBytes: undefined,
      datums: [],
      datumsBytes: undefined,
      scriptDataHash: undefined,
    });
  });

  it('reads body key 11 without redeemers, datums or scripts', () => {
    const declared = new Uint8Array(32).fill(9);
    expect(factsOf(withWitnessSet('a0', [[11n, declared]])).scriptDataHash).toEqual(declared);
  });

  it('keeps the original bytes of redeemer data in the legacy array form, the later of two equal keys wins', () => {
    // [[0, 0, [_ 1], [1, 1]], [1, 0, 2, [2, 2]], [0, 0, [_ 3], [3, 3]]]: indefinite lists a re-encoder would write as 81 01.
    const redeemers = '83' + '8400009f01ff820101' + '840100028202' + '02' + '8400009f03ff820303';
    const facts = factsOf(withWitnessSet('a105' + redeemers));
    expect(facts.redeemers).toEqual([
      { tag: 0n, index: 0n, mem: 3n, steps: 3n },
      { tag: 1n, index: 0n, mem: 2n, steps: 2n },
    ]);
    expect(facts.redeemerData).toEqual([
      { tag: 0n, index: 0n, data: hexToBytes('9f03ff') },
      { tag: 1n, index: 0n, data: hexToBytes('02') },
    ]);
    expect(facts.redeemersBytes).toEqual(hexToBytes(redeemers));
  });

  it('keeps the original bytes of redeemer data in the Conway map form, definite and indefinite', () => {
    // {[0, 0] => [[_ 1], [1, 1]], [3, 2] => [h'ab', [5, 6]]}
    const definite = 'a2' + '820000' + '829f01ff820101' + '820302' + '8241ab820506';
    const indefinite = 'bf' + '820000' + '829f01ff820101' + '820302' + '8241ab820506' + 'ff';
    for (const redeemers of [definite, indefinite]) {
      const facts = factsOf(withWitnessSet('a105' + redeemers));
      expect(facts.redeemers).toEqual([
        { tag: 0n, index: 0n, mem: 1n, steps: 1n },
        { tag: 3n, index: 2n, mem: 5n, steps: 6n },
      ]);
      expect(facts.redeemerData).toEqual([
        { tag: 0n, index: 0n, data: hexToBytes('9f01ff') },
        { tag: 3n, index: 2n, data: hexToBytes('41ab') },
      ]);
      expect(facts.redeemersBytes).toEqual(hexToBytes(redeemers));
    }
  });

  it('a repeated key in the map form keeps the later data at the position of the first', () => {
    // {[0, 0] => [1, [1, 1]], [1, 0] => [2, [2, 2]], [0, 0] => [3, [3, 3]]}
    const facts = factsOf(withWitnessSet('a105' + 'a3' + '820000820182010182010082028202028200008203820303'));
    expect(facts.redeemerData).toEqual([
      { tag: 0n, index: 0n, data: hexToBytes('03') },
      { tag: 1n, index: 0n, data: hexToBytes('02') },
    ]);
  });

  it('reads datums as a plain array and as a tag 258 set, hashed over their original bytes, each hash once', () => {
    // 42, the constructor 121 [] and an indefinite [_ 1], then 42 again.
    const items = ['182a', 'd87980', '9f01ff'];
    const plain = '84' + items.join('') + '182a';
    const tagged = 'd9010283' + items.join('');
    const expected = items.map((hex) => ({ hash: blake256(hex), bytes: hexToBytes(hex) }));
    // CSL hashes a datum over the bytes it was read from as well.
    expect(expected.map((d) => d.hash)).toEqual(items.map((hex) => CSL.hash_plutus_data(CSL.PlutusData.from_hex(hex)).to_bytes()));
    for (const datums of [plain, tagged]) {
      const facts = factsOf(withWitnessSet('a104' + datums));
      expect(facts.datums).toEqual(expected);
      expect(facts.datumsBytes).toEqual(hexToBytes(datums));
    }
  });

  it('reads Plutus scripts of keys 3, 6 and 7 in key order, a tag 258 set included, each hash once', () => {
    const v3 = bytesToHex(concat(hexToBytes('585e'), ALWAYS.bytes));
    const v1 = '4e' + V1.cborHex;
    // {3: [v1, v1], 7: 258([v3]), 6: [v2]}: the map order differs from the key order.
    const facts = factsOf(withWitnessSet('a3' + '0382' + v1 + v1 + '07d9010281' + v3 + '0681' + '4e' + V2.cborHex));
    expect(facts.plutusScripts.map((s) => [s.language, bytesToHex(s.hash), bytesToHex(s.bytes)])).toEqual([
      [1, V1.hashHex, V1.cborHex],
      [2, V2.hashHex, V2.cborHex],
      [3, ALWAYS.hashHex, ALWAYS.cborHex],
    ]);
  });
});

describe('readTransaction: malformed Plutus fields', () => {
  it.each<[string, string, Array<[bigint, unknown]>, string]>([
    ['datums that are no array', 'a10401', [], 'malformed datums'],
    ['datums in a tag other than 258', 'a104d9010381182a', [], 'malformed datums'],
    ['an empty datum list', 'a10480', [], 'malformed datums'],
    ['a datum that is a text string', 'a104816161', [], 'malformed datum'],
    ['redeemer data that is a text string in the array form', 'a105818400006161820101', [], 'malformed redeemer data'],
    ['redeemer data that is a text string in the map form', 'a105a1820000826161820101', [], 'malformed redeemer data'],
    ['a script data hash of 31 bytes', 'a0', [[11n, new Uint8Array(31)]], 'malformed script data hash'],
  ])('refuses %s', (_name, witnessSet, body, message) => {
    expect(() => factsOf(withWitnessSet(witnessSet, body))).toThrow(message);
  });
});
