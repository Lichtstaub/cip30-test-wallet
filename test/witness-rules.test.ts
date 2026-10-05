import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Data, NativeScripts, PlutusV3, ScriptHash, Transaction, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { baseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { decode, Tagged, type CborValue } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseTransaction, spentInputs } from '../src/core/cbor/tx.js';
import { keyHash, publicKey, sign, type SigningKey } from '../src/core/keys.js';
import type { Utxo } from '../src/core/ledger.js';
import { requirements } from '../src/core/requirements.js';
import { scriptHash } from '../src/core/scripts.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import type { CheckContext } from '../src/host/checks/context.js';
import { mismatch } from '../src/host/checks/failure.js';
import { plutusNeeds } from '../src/host/checks/plutus-purposes.js';
import { witnessFailures } from '../src/host/checks/witness-rules.js';
import { buildTx, outpoints, spliceWitnessSet } from './helpers/build-tx.js';
import { checkContext } from './helpers/check-context.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { lockedUtxo } from './helpers/plutus-spend.js';
import { PLUTUS_V3, hash28 as h, syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const other = deriveAccount(MNEMONIC, 1);
const third = deriveAccount(MNEMONIC, 2);
const hashOf = (key: SigningKey) => keyHash(publicKey(key));
const myPay = hashOf(me.payment);
const myStake = hashOf(me.stake);
const myAddress = baseAddressBytes(0, myPay, myStake);
const PLUTUS = hexToBytes(PLUTUS_V3);

type Native = unknown[];
const pubkey = (hash: Uint8Array): Native => [0n, hash];
const all = (...scripts: Native[]): Native => [1n, scripts];
const any = (...scripts: Native[]): Native => [2n, scripts];
const nOfK = (n: bigint, ...scripts: Native[]): Native => [3n, n, scripts];
const before = (slot: bigint): Native => [4n, slot];
const nativeHash = (script: Native) => scriptHash(0, encode(script as never));
/** Testnet enterprise address with a script payment credential (header type 7). */

const mine: Utxo = { input: syntheticInput('witness-mine', 0n), address: myAddress, lovelace: 10_000_000n };
const locked = (hash: Uint8Array, seed = 'witness-locked'): Utxo => lockedUtxo({ hash }, seed);
const holding = (seed: string, scriptRef: Uint8Array): Utxo => ({ input: syntheticInput(seed, 0n), address: myAddress, lovelace: 20_000_000n, scriptRef });

/** requirements over the spent inputs and the Plutus needs, the way checkTransaction calls it. */
function witnessRules(ctx: CheckContext) {
  const reqs = requirements(ctx.parsed.body, ctx.resolved.slice(0, spentInputs(ctx.parsed.body).length));
  return witnessFailures(ctx, reqs, plutusNeeds(ctx));
}
const rules = (ctx: CheckContext) => witnessRules(ctx).map((f) => f.rule);

interface ScriptTx {
  inputs?: Utxo[];
  body?: Array<[bigint, unknown]>;
  natives?: Native[];
  plutus?: Uint8Array[];
}
function scriptTx(opts: ScriptTx, vkeys: Array<[Uint8Array, Uint8Array]> = []): string {
  const witnessSet = new Map<bigint, unknown>();
  if (vkeys.length > 0) witnessSet.set(0n, vkeys);
  if (opts.natives?.length) witnessSet.set(1n, opts.natives);
  if (opts.plutus?.length) witnessSet.set(7n, opts.plutus);
  return buildTx({ inputs: (opts.inputs ?? [mine]).map((u) => u.input), outputs: [], fee: 200_000n, extraBodyEntries: new Map(opts.body ?? []), witnessSet });
}
/** The same transaction with a valid witness of every key. The body and so its hash stay the same. */
function signedBy(opts: ScriptTx, ...keys: SigningKey[]): string {
  const { hash } = parseTransaction(hexToBytes(scriptTx(opts)));
  return scriptTx(opts, keys.map((k) => [publicKey(k), sign(k, hash)]));
}

describe('native scripts', () => {
  it('any with two different satisfying witness sets: both pass, one key short fails', () => {
    const script = any(all(pubkey(myPay), pubkey(myStake)), pubkey(hashOf(other.payment)));
    const u = locked(nativeHash(script));
    const opts: ScriptTx = { inputs: [mine, u], natives: [script] };
    expect(rules(checkContext(signedBy(opts, me.payment, me.stake), [mine, u]))).toEqual([]);
    expect(rules(checkContext(signedBy(opts, me.payment, other.payment), [mine, u]))).toEqual([]);
    expect(rules(checkContext(signedBy(opts, me.payment), [mine, u]))).toEqual(['ScriptWitnessNotValidatingUTXOW']);
    expect(witnessRules(checkContext(signedBy(opts, me.payment), [mine, u]))[0]!.detail).toBe(`[${bytesToHex(nativeHash(script))}]`);
  });

  it('any with two different satisfying witness sets, built by Evolution', async () => {
    const script = NativeScripts.makeScriptAny([
      NativeScripts.makeScriptAll([NativeScripts.makeScriptPubKey(myPay).script, NativeScripts.makeScriptPubKey(myStake).script]).script,
      NativeScripts.makeScriptPubKey(hashOf(other.payment)).script,
    ]);
    const input = syntheticInput('witness-evolution-any', 0n);
    const scriptAddr = new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(script) });
    const lockedEvo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address: scriptAddr, assets: Assets.fromLovelace(5_000_000n) });
    const lockedUtxo: Utxo = { input, address: Address.toBytes(scriptAddr), lovelace: 5_000_000n };
    const tx = await evolutionBuild((b) => b.attachScript({ script }).collectFrom({ inputs: [lockedEvo] }), myAddress, [evolutionUtxo(mine, myAddress)]);
    for (const keys of [[me.payment, me.stake], [me.payment, other.payment]]) {
      const signed = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, keys));
      expect(rules(checkContext(signed, [mine, lockedUtxo]))).toEqual([]);
    }
  });

  it('2 of 3 with the wallet key and one foreign co-signer passes, the wallet key alone fails', () => {
    const script = nOfK(2n, pubkey(myPay), pubkey(hashOf(other.payment)), pubkey(hashOf(third.payment)));
    const u = locked(nativeHash(script));
    const opts: ScriptTx = { inputs: [mine, u], natives: [script] };
    expect(rules(checkContext(signedBy(opts, me.payment, third.payment), [mine, u]))).toEqual([]);
    expect(rules(checkContext(signedBy(opts, me.payment), [mine, u]))).toEqual(['ScriptWitnessNotValidatingUTXOW']);
  });

  it('timelocks read the validity interval of the transaction, never the current slot', () => {
    const script = all(pubkey(myPay), before(100n));
    const u = locked(nativeHash(script));
    const at = (start?: bigint) => signedBy({ inputs: [mine, u], natives: [script], body: start === undefined ? [] : [[8n, start]] }, me.payment);
    expect(rules(checkContext(at(100n), [mine, u], { currentSlot: 50n }))).toEqual([]);
    expect(rules(checkContext(at(99n), [mine, u], { currentSlot: 500n }))).toEqual(['ScriptWitnessNotValidatingUTXOW']);
    expect(rules(checkContext(at(), [mine, u], { currentSlot: 500n }))).toEqual(['ScriptWitnessNotValidatingUTXOW']);
  });

  it('a native script from a reference script is evaluated too', () => {
    const script = all(pubkey(myStake));
    const u = locked(nativeHash(script));
    const holder = holding('witness-ref-native', encode([0n, script] as never));
    const opts: ScriptTx = { inputs: [mine, u], body: [[18n, outpoints(holder)]] };
    expect(rules(checkContext(signedBy(opts, me.payment, me.stake), [mine, u, holder]))).toEqual([]);
    expect(rules(checkContext(signedBy(opts, me.payment), [mine, u, holder]))).toEqual(['ScriptWitnessNotValidatingUTXOW']);
  });
});

describe('script presence', () => {
  const plutusHash = scriptHash(3, PLUTUS);
  // The hand-built spends carry no redeemer: a script found by reference still needs one, and a script data hash.
  const NO_REDEEMER = ['MissingRedeemers', 'ScriptIntegrityHashMismatch'];

  it('an Evolution Plutus spend with collateral passes, without its script MissingScriptWitnessesUTXOW', async () => {
    const plutus = new PlutusV3.PlutusV3({ bytes: PLUTUS });
    const input = syntheticInput('witness-plutus', 0n);
    const scriptAddr = new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(plutus) });
    const lockedEvo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address: scriptAddr, assets: Assets.fromLovelace(5_000_000n) });
    const lockedUtxo: Utxo = { input, address: Address.toBytes(scriptAddr), lovelace: 5_000_000n };
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [lockedEvo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      myAddress,
      [evolutionUtxo(mine, myAddress)],
      { evaluator: fixedBudgetEvaluator },
    );
    const signed = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [me.payment]));
    const ctx = checkContext(signed, [mine, lockedUtxo]);
    expect(ctx.parsed.body.collateralInputs).toHaveLength(1);
    expect(rules(ctx)).toEqual([]);

    // The same body with the Plutus script taken out of the witness set.
    const [, witnessSet] = decode(hexToBytes(signed)) as [unknown, Map<CborValue, CborValue>];
    witnessSet.delete(7n);
    const stripped = spliceWitnessSet(signed, bytesToHex(encode(witnessSet)));
    const failures = witnessRules(checkContext(stripped, [mine, lockedUtxo]));
    // Without the script nothing needs the redeemer, and the script data hash still covers the PlutusV3 cost model.
    expect(failures.map((f) => f.rule)).toEqual(['MissingScriptWitnessesUTXOW', 'ExtraRedeemers', 'ScriptIntegrityHashMismatch']);
    expect(failures[0]!.detail).toBe(`[${bytesToHex(plutusHash)}]`);
  });

  it('a script from the reference script of a spend or reference input needs no witness', () => {
    const u = locked(plutusHash);
    const holder = holding('witness-ref-holder', encode([3n, PLUTUS]));
    expect(rules(checkContext(signedBy({ inputs: [mine, u], body: [[18n, outpoints(holder)]] }, me.payment), [mine, u, holder]))).toEqual(NO_REDEEMER);
    const spentHolder = holding('witness-spent-holder', encode([3n, PLUTUS]));
    expect(rules(checkContext(signedBy({ inputs: [spentHolder, u] }, me.payment), [spentHolder, u]))).toEqual(NO_REDEEMER);
  });

  it('a reference script on a collateral input provides nothing', () => {
    const u = locked(plutusHash);
    const collateralHolder = holding('witness-collateral-holder', encode([3n, PLUTUS]));
    const tx = signedBy({ inputs: [mine, u], body: [[13n, outpoints(collateralHolder)]] }, me.payment);
    expect(rules(checkContext(tx, [mine, u, collateralHolder]))).toEqual(['MissingScriptWitnessesUTXOW']);
  });

  it('ExtraneousScriptWitnessesUTXOW: a witness script nothing needs', () => {
    const unneeded = all(pubkey(myPay));
    expect(rules(checkContext(signedBy({ natives: [unneeded] }, me.payment), [mine]))).toEqual(['ExtraneousScriptWitnessesUTXOW']);
    expect(rules(checkContext(signedBy({ plutus: [PLUTUS] }, me.payment), [mine]))).toEqual(['ExtraneousScriptWitnessesUTXOW']);
  });

  it('ExtraneousScriptWitnessesUTXOW: a needed script in the witness set that a reference input already provides', () => {
    const u = locked(plutusHash);
    const holder = holding('witness-double', encode([3n, PLUTUS]));
    const tx = signedBy({ inputs: [mine, u], body: [[18n, outpoints(holder)]], plutus: [PLUTUS] }, me.payment);
    expect(rules(checkContext(tx, [mine, u, holder]))).toEqual(['ExtraneousScriptWitnessesUTXOW', ...NO_REDEEMER]);
  });
});

describe('vkey witnesses', () => {
  it('InvalidWitnessesUTXOW: a bad signature fails even when every required key is covered', () => {
    const tx = signedBy({}, me.payment);
    const wrong = sign(other.payment, new Uint8Array(32));
    const withBad = scriptTx({}, [
      [publicKey(me.payment), sign(me.payment, parseTransaction(hexToBytes(tx)).hash)],
      [publicKey(other.payment), wrong],
    ]);
    const failures = witnessRules(checkContext(withBad, [mine]));
    expect(failures.map((f) => f.rule)).toEqual(['InvalidWitnessesUTXOW']);
    expect(failures[0]!.detail).toBe(`[${bytesToHex(publicKey(other.payment))}]`);
    expect(rules(checkContext(tx, [mine]))).toEqual([]);
  });

  it('a bad signature for a required key counts as present, the node reports it only as InvalidWitnessesUTXOW', () => {
    const bad = scriptTx({}, [[publicKey(me.payment), sign(me.payment, new Uint8Array(32))]]);
    const found = rules(checkContext(bad, [mine]));
    expect(found).toEqual(['InvalidWitnessesUTXOW']);
    expect(found).not.toContain('MissingVKeyWitnessesUTXOW');
  });

  it('MissingVKeyWitnessesUTXOW: every required key hash without a witness, foreign ones included', () => {
    const signer = hashOf(other.payment);
    const pool = h(7);
    const opts: ScriptTx = { body: [[14n, new Tagged(258n, [signer])], [4n, [[4n, pool, 300n]]]] };
    const failures = witnessRules(checkContext(signedBy(opts, me.payment), [mine]));
    expect(failures.map((f) => f.rule)).toEqual(['MissingVKeyWitnessesUTXOW']);
    expect(failures[0]!.detail).toBe(`[${bytesToHex(signer)}, ${bytesToHex(pool)}]`);
    expect(rules(checkContext(signedBy(opts, me.payment, other.payment), [mine]))).toEqual(['MissingVKeyWitnessesUTXOW']);
    expect(rules(checkContext(scriptTx(opts), [mine]))).toEqual(['MissingVKeyWitnessesUTXOW']);
  });

  it('an input the UTxO set does not hold requires no witness here, BadInputsUTxO reports it', () => {
    const theirs: Utxo = { input: syntheticInput('witness-theirs', 0n), address: baseAddressBytes(0, hashOf(other.payment), myStake), lovelace: 1n };
    const tx = signedBy({ inputs: [mine, theirs] }, me.payment);
    expect(rules(checkContext(tx, [mine]))).toEqual([]);
    expect(rules(checkContext(tx, [mine, theirs]))).toEqual(['MissingVKeyWitnessesUTXOW']);
  });
});

describe('metadata hash', () => {
  const aux = encode(new Map([[674n, 'hello']]) as never);
  // CSL as the independent oracle for the hash over these bytes.
  const auxHash = CSL.hash_auxiliary_data(CSL.AuxiliaryData.from_bytes(aux)).to_bytes();
  /** The signed transaction with this item as auxiliary data in place of null. Witnesses sign the body only, they stay valid. */
  const withAux = (txHex: string, item: Uint8Array) => bytesToHex(concat(hexToBytes(txHex).slice(0, -1), item));
  const declaring = (hash: Uint8Array) => signedBy({ body: [[7n, hash]] }, me.payment);

  it('passes with auxiliary data whose hash body key 7 declares', () => {
    expect(rules(checkContext(withAux(declaring(auxHash), aux), [mine]))).toEqual([]);
  });

  it('MissingTxBodyMetadataHash: auxiliary data without body key 7, with the hash it has', () => {
    const failures = witnessRules(checkContext(withAux(signedBy({}, me.payment), aux), [mine]));
    expect(failures.map((f) => f.rule)).toEqual(['MissingTxBodyMetadataHash']);
    expect(failures[0]!.detail).toBe(bytesToHex(auxHash));
  });

  it('MissingTxMetadata: body key 7 without auxiliary data, with the declared hash', () => {
    const failures = witnessRules(checkContext(declaring(auxHash), [mine]));
    expect(failures.map((f) => f.rule)).toEqual(['MissingTxMetadata']);
    expect(failures[0]!.detail).toBe(bytesToHex(auxHash));
  });

  it('ConflictingMetadataHash: supplied is body key 7, expected the hash of the auxiliary data', () => {
    const declared = new Uint8Array(32).fill(9);
    const failures = witnessRules(checkContext(withAux(declaring(declared), aux), [mine]));
    expect(failures.map((f) => f.rule)).toEqual(['ConflictingMetadataHash']);
    expect(failures[0]!.detail).toBe(mismatch('RelEQ', bytesToHex(declared), bytesToHex(auxHash)));
  });

  it('comes after MissingVKeyWitnessesUTXOW, as validateMetadata follows validateNeededWitnesses', () => {
    expect(rules(checkContext(withAux(scriptTx({}), aux), [mine]))).toEqual(['MissingVKeyWitnessesUTXOW', 'MissingTxBodyMetadataHash']);
  });

  it('a transaction CSL built with metadata and its hash raises no metadata failure', () => {
    const metadata = CSL.GeneralTransactionMetadata.new();
    metadata.insert(CSL.BigNum.from_str('674'), CSL.TransactionMetadatum.new_text('hello'));
    const cslAux = CSL.AuxiliaryData.new();
    cslAux.set_metadata(metadata);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(mine.input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), CSL.BigNum.from_str('200000'));
    body.set_auxiliary_data_hash(CSL.hash_auxiliary_data(cslAux));
    const tx = CSL.Transaction.new(body, CSL.TransactionWitnessSet.new(), cslAux).to_hex();
    // Unsigned, only the wallet key is missing.
    expect(rules(checkContext(tx, [mine]))).toEqual(['MissingVKeyWitnessesUTXOW']);
  });
});
