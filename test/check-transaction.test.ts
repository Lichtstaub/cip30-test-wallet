import { describe, expect, it } from 'vitest';
import { Address, Assets, Data, PlutusV3, ScriptHash, Transaction, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { baseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { keyHash, publicKey, sign, type SigningKey } from '../src/core/keys.js';
import type { Utxo } from '../src/core/ledger.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { formatFailures, renderFailure } from '../src/host/checks/failure.js';
import { checkTransaction, MAX_REF_SCRIPT_SIZE_PER_TX } from '../src/host/checks/index.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { buildTx, outpoints, type BuildTxOptions } from './helpers/build-tx.js';
import { checkContext } from './helpers/check-context.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { lockedUtxo, scriptWitnesses } from './helpers/plutus-spend.js';
import { PLUTUS_V3, hash28 as h, syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const myAddress = baseAddressBytes(0, myPay, myStake);
const mine = (seed: string, lovelace = 10_000_000n): Utxo => ({ input: syntheticInput(seed, 0n), address: myAddress, lovelace });
/** A Plutus V3 reference script whose byte string holds size bytes, above the per transaction limit when size is. */
const bigRef = (size: number) => encode([3n, new Uint8Array(size).fill(1)]);

/** buildTx with a valid witness of every key: the body is built once, then signed over its hash. */
function signed(opts: BuildTxOptions, ...keys: SigningKey[]): string {
  const { hash } = parseTransaction(hexToBytes(buildTx(opts)));
  const witnessSet = new Map(opts.witnessSet ?? []);
  if (keys.length > 0) witnessSet.set(0n, keys.map((k) => [publicKey(k), sign(k, hash)]));
  return buildTx({ ...opts, witnessSet });
}
const check = (tx: string, unspent: Utxo[], opts: Parameters<typeof checkContext>[2] = {}) => checkTransaction(checkContext(tx, unspent, opts));
const rules = (tx: string, unspent: Utxo[], opts: Parameters<typeof checkContext>[2] = {}) => check(tx, unspent, opts).failures.map((f) => f.rule);

describe('mempool', () => {
  it('all spend inputs spent: only ConwayMempoolFailure, whatever else is wrong', () => {
    const a = mine('mempool-a');
    const b = mine('mempool-b');
    const tx = buildTx({ inputs: [a.input, b.input], outputs: [{ address: myAddress, lovelace: 1n }], fee: 1n });
    const { failures, unsupported } = check(tx, []);
    expect(unsupported).toEqual([]);
    expect(failures).toEqual([{ path: [], rule: 'ConwayMempoolFailure', detail: '"All inputs are spent. Transaction has probably already been included"' }]);
    expect(formatFailures(failures)).toBe('ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]');
  });

  it('an empty input set is a mempool failure too, InputSetEmptyUTxO never shows', () => {
    expect(rules(buildTx({ inputs: [], outputs: [], fee: 200_000n }), [])).toEqual(['ConwayMempoolFailure']);
  });

  it('a collateral or reference input still unspent does not count, only spend inputs do', () => {
    const a = mine('mempool-spent');
    const c = mine('mempool-collateral', 5_000_000n);
    const tx = buildTx({ inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[13n, outpoints(c)], [18n, outpoints(c)]]) });
    expect(rules(tx, [c])).toEqual(['ConwayMempoolFailure']);
  });

  it('a double submit with one input already spent: BadInputsUTxO and ValueNotConservedUTxO together', () => {
    const a = mine('partial-a');
    const b = mine('partial-b', 5_000_000n);
    const tx = signed({ inputs: [a.input, b.input], outputs: [{ address: myAddress, lovelace: 14_800_000n }], fee: 200_000n }, me.payment);
    expect(rules(tx, [a, b])).toEqual([]);
    const found = rules(tx, [a]);
    expect(found).toContain('BadInputsUTxO');
    expect(found).toContain('ValueNotConservedUTxO');
    expect(found).not.toContain('ConwayMempoolFailure');
  });
});

describe('forms the checks do not judge', () => {
  const a = mine('unsupported-a');
  const byron = concat(Uint8Array.of(0x82), h(1));
  const cases: Array<[string, BuildTxOptions, Utxo[], string]> = [
    ['an output at a Byron address', { inputs: [a.input], outputs: [{ address: byron, lovelace: 9_800_000n }], fee: 200_000n }, [a], 'an output at a Byron address'],
    ['a collateral return at a Byron address', { inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[16n, [byron, 1_000_000n]]]) }, [a], 'a collateral return at a Byron address'],
    ['a bootstrap witness', { inputs: [a.input], outputs: [], fee: 200_000n, witnessSet: new Map([[2n, [[new Uint8Array(32), new Uint8Array(64), new Uint8Array(32), new Uint8Array(1)]]]]) }, [a], 'bootstrap witnesses'],
    ['certificate 5', { inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[4n, [[5n, h(1), h(2), new Uint8Array(32)]]]]) }, [a], 'certificate 5, deprecated since Conway'],
    ['certificate 6', { inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[4n, [[6n, [0n, new Map()]]]]]) }, [a], 'certificate 6, deprecated since Conway'],
    ['body key 6 (update)', { inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[6n, [new Map(), 1n]]]) }, [a], 'body key 6 (update)'],
    ['an input at a Byron address', { inputs: [a.input], outputs: [], fee: 200_000n }, [{ ...a, address: byron }], 'an input at a Byron address'],
  ];

  it.each(cases)('%s', (_name, opts, unspent, message) => {
    expect(check(buildTx(opts), unspent)).toEqual({ failures: [], unsupported: [message], needs: [] });
  });

  it('names a form once when several inputs or certificates share it', () => {
    const b = mine('unsupported-b');
    const twoByron = buildTx({ inputs: [a.input, b.input], outputs: [], fee: 200_000n });
    expect(check(twoByron, [{ ...a, address: byron }, { ...b, address: byron }]).unsupported).toEqual(['an input at a Byron address']);
    const twoCerts = buildTx({ inputs: [a.input], outputs: [], fee: 200_000n, extraBodyEntries: new Map([[4n, [[5n, h(1), h(2), new Uint8Array(32)], [5n, h(3), h(4), new Uint8Array(32)]]]]) });
    expect(check(twoCerts, [a]).unsupported).toEqual(['certificate 5, deprecated since Conway']);
  });

  it('the mempool check comes first', () => {
    expect(check(buildTx({ inputs: [a.input], outputs: [{ address: byron, lovelace: 1n }], fee: 1n }), []).unsupported).toEqual([]);
  });
});

describe('ledger order', () => {
  const a = mine('order-a');
  const holder: Utxo = { input: syntheticInput('order-holder', 0n), address: myAddress, lovelace: 5_000_000n, scriptRef: bigRef(Number(MAX_REF_SCRIPT_SIZE_PER_TX) + 1) };
  // A failing script, so the is_valid false case agrees with phase 2. Phase 1 fails anyway, nothing runs it.
  const alwaysFails = plutusScript('v3_always_fails');
  const locked = lockedUtxo(alwaysFails, 'order-locked');
  const { witnessSet, scriptDataHash } = scriptWitnesses([{ utxo: locked, script: alwaysFails }], [a, locked]);
  // Unregisters a credential the state does not hold, spends without a witness, pays a fee of 1.
  const opts = (isValid: boolean): BuildTxOptions => ({
    inputs: [a.input, locked.input],
    outputs: [{ address: myAddress, lovelace: 14_999_999n }],
    fee: 1n,
    isValid,
    witnessSet,
    extraBodyEntries: new Map<bigint, unknown>([
      [18n, outpoints(holder)],
      [4n, [[8n, [0n, h(9)], 2_000_000n]]],
      [11n, scriptDataHash],
      [13n, outpoints(a)],
    ]),
  });

  it('LEDGER, then CERTS, then UTXOW, then UTXO', () => {
    const { failures } = check(buildTx(opts(true)), [a, holder, locked]);
    expect(failures.map((f) => f.rule)).toEqual(['ConwayTxRefScriptsSizeTooBig', 'StakeKeyNotRegisteredDELEG', 'MissingVKeyWitnessesUTXOW', 'FeeTooSmallUTxO']);
    expect(renderFailure(failures[0]!)).toBe(`ConwayTxRefScriptsSizeTooBig (Mismatch (RelLTEQ) {supplied: ${MAX_REF_SCRIPT_SIZE_PER_TX + 1n}, expected: ${MAX_REF_SCRIPT_SIZE_PER_TX}})`);
    expect(renderFailure(failures[2]!)).toMatch(/^ConwayUtxowFailure \(MissingVKeyWitnessesUTXOW \(/);
    expect(renderFailure(failures[3]!)).toMatch(/^ConwayUtxowFailure \(UtxoFailure \(FeeTooSmallUTxO \(Mismatch \(RelGTEQ\) \{supplied: Coin 1, expected: Coin \d+\}\)\)\)$/);
  });

  it('is_valid false skips the reference script limit and CERTS, UTXOW and UTXO still run', () => {
    expect(rules(buildTx(opts(false)), [a, holder, locked])).toEqual(['MissingVKeyWitnessesUTXOW', 'FeeTooSmallUTxO']);
  });

  it('UTXOW runs the datum and redeemer rules after script presence and the integrity hash after the key witnesses, CollectErrors comes last', () => {
    const v2 = plutusScript('v2_always_succeeds');
    const noDatum = lockedUtxo(v2, 'order-no-datum');
    // No redeemers, an extraneous script, a V2 spend without a datum, a wrong integrity hash, no signature, a fee of 1.
    const tx = buildTx({
      inputs: [a.input, locked.input, noDatum.input],
      outputs: [{ address: myAddress, lovelace: 19_999_999n }],
      fee: 1n,
      witnessSet: new Map<bigint, unknown>([
        [6n, [v2.bytes]],
        [7n, [alwaysFails.bytes, plutusScript('v3_always_succeeds').bytes]],
      ]),
      extraBodyEntries: new Map<bigint, unknown>([[11n, new Uint8Array(32).fill(0x11)]]),
    });
    const { failures, needs } = check(tx, [a, locked, noDatum]);
    expect(needs).toHaveLength(2);
    expect(failures.map((f) => f.rule)).toEqual([
      'ExtraneousScriptWitnessesUTXOW',
      'UnspendableUTxONoDatumHash',
      'MissingRedeemers',
      'MissingVKeyWitnessesUTXOW',
      'ScriptIntegrityHashMismatch',
      'FeeTooSmallUTxO',
      'CollectErrors',
    ]);
    expect(renderFailure(failures[6]!)).toMatch(/^ConwayUtxowFailure \(UtxoFailure \(UtxosFailure \(CollectErrors \(NoRedeemer .* :\| \[NoRedeemer .*\]\)\)\)\)$/);
  });

  it('reference scripts up to the limit pass', () => {
    const atLimit: Utxo = { ...holder, scriptRef: bigRef(Number(MAX_REF_SCRIPT_SIZE_PER_TX)) };
    expect(rules(buildTx(opts(true)), [a, atLimit, locked])).not.toContain('ConwayTxRefScriptsSizeTooBig');
  });
});

describe('transactions a node accepts', () => {
  const own = [mine('accept-a', 50_000_000n), mine('accept-b', 10_000_000n)];
  const ownEvo = own.map((u) => evolutionUtxo(u, myAddress));

  it('an Evolution-built balanced payment signed by the wallet key passes with the preprod parameters', async () => {
    const tx = await evolutionBuild((b) => b.payToAddress({ address: Address.fromBytes(hexToBytes('00' + '22'.repeat(56))), assets: Assets.fromLovelace(2_000_000n) }), myAddress, ownEvo);
    const complete = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [me.payment]));
    expect(check(complete, own, { params: DEFAULT_PROTOCOL_PARAMS[0] })).toEqual({ failures: [], unsupported: [], needs: [] });
    // Unsigned, the same transaction misses the wallet key.
    expect(rules(tx, own)).toEqual(['MissingVKeyWitnessesUTXOW']);
  });

  it('an Evolution-built Plutus spend with collateral passes phase 1 and names its one script to run', async () => {
    const plutus = new PlutusV3.PlutusV3({ bytes: hexToBytes(PLUTUS_V3) });
    const input = syntheticInput('accept-plutus', 0n);
    const scriptAddr = new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(plutus) });
    const lockedEvo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address: scriptAddr, assets: Assets.fromLovelace(5_000_000n) });
    const locked: Utxo = { input, address: Address.toBytes(scriptAddr), lovelace: 5_000_000n };
    const tx = await evolutionBuild((b) => b.collectFrom({ inputs: [lockedEvo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }), myAddress, ownEvo, { evaluator: fixedBudgetEvaluator });
    const complete = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [me.payment]));
    const { failures, unsupported, needs } = check(complete, [...own, locked]);
    expect({ failures, unsupported }).toEqual({ failures: [], unsupported: [] });
    expect(needs.map((n) => [n.tag, n.language, bytesToHex(n.scriptHash)])).toEqual([[0n, 3, plutusScript('v3_always_succeeds').hashHex]]);
  });
});
