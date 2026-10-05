// The checked ledger as the fixture uses it: every transaction below is signed
// for real, so the rules see complete witnesses, and the node's rule names are
// read from info with toContain, never compared as a whole.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Data, PlutusV3, ScriptHash, Transaction, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import type { Evaluator } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { blake2b } from '@noble/hashes/blake2.js';
import { baseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { APIErrorCode, ChwError, isCip30Error, TxSendErrorCode, type Cip30Error } from '../src/core/errors.js';
import { keyHash, publicKey, type SigningKey } from '../src/core/keys.js';
import { MemoryLedger, type Datum, type Ledger, type Utxo } from '../src/core/ledger.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { CheckedLedger } from '../src/host/checks/checked-ledger.js';
import { credentialKey } from '../src/host/checks/read-tx.js';
import { DEFAULT_MNEMONIC, prepareWallet, type WalletOptions } from '../src/host/config.js';
import { LEDGER_BINDING, walletLedger } from '../src/host/ledger.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { installWallet, syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx, outpoints, spliceWitnessSet } from './helpers/build-tx.js';
import { budgetEvaluator, evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { enableChw, pageWith, rejectionOf } from './helpers/page.js';
import { plutusScript, type PlutusFixture } from './helpers/plutus-fixtures.js';
import { foreignConfig, inlineDatum, lockedUtxo, plutusSpend, scriptWitnesses, UNIT_DATA, withVKeys } from './helpers/plutus-spend.js';
import { syntheticInput } from './helpers/synthetic.js';

type DemoTx = { unsignedHex: string; bodyEndHex: number };
const DEMO = vm.runInNewContext(`${readFileSync('examples/minimal-dapp/demo-tx.js', 'utf8')}\n;({ DEMO_TX, DEMO_DELEG_TX })`) as Record<'DEMO_TX' | 'DEMO_DELEG_TX', DemoTx>;

const account = deriveAccount(DEFAULT_MNEMONIC);
const other = deriveAccount(DEFAULT_MNEMONIC, 1);
const stakeHash = keyHash(publicKey(account.stake));
const drepHash = keyHash(publicKey(account.drep));
const ownStake = credentialKey({ isScript: false, hash: stakeHash });
const otherAddress = baseAddressBytes(0, keyHash(publicKey(other.payment)), keyHash(publicKey(other.stake)));
const keys = (utxos: Utxo[]) => utxos.map((u) => `${bytesToHex(u.input.txId)}#${u.input.index}`);

function checked(ledger: Ledger): CheckedLedger {
  if (!(ledger instanceof CheckedLedger)) throw new Error('walletLedger did not return a checked ledger');
  return ledger;
}

/** A wallet with ledger checks, its ledger as the fixture builds it, and its synthetic UTxOs by position. */
function checkedWallet(options: WalletOptions = {}) {
  const w = prepareWallet({ ...options, ledger: { checks: true, ...options.ledger } });
  const ledger = checked(walletLedger(w));
  const address = parseAddressArg(w.addresses.payment);
  const utxo = (i: number) => syntheticOwnedUtxo(w.config.name, i, address, BigInt(w.config.utxos[i]!.lovelace));
  return { w, ledger, address, utxo };
}

/** The transaction with a witness set holding exactly these keys' signatures. */
const signed = (tx: string, keys: SigningKey[] = [account.payment]) => hexToBytes(spliceWitnessSet(tx, signWithKeys(tx, keys)));

async function snapshot(ledger: CheckedLedger) {
  return { utxos: await ledger.getWalletUtxos(), submitted: ledger.inner.submitted.length, certState: ledger.certState, stakeRegistered: await ledger.getStakeRegistered() };
}

/** The submit must fail with a plain TxSendError Failure object, the shape a dApp receives. */
async function rejection(ledger: Ledger, tx: Uint8Array): Promise<Cip30Error> {
  const error = await rejectionOf(ledger.submit(tx));
  expect(isCip30Error(error), `a plain CIP-30 error, got ${String(error)}`).toBe(true);
  expect(error).toMatchObject({ code: TxSendErrorCode.Failure });
  return error as Cip30Error;
}

describe('walletLedger', () => {
  it('checks only with ledger.checks, on the default parameters of the network', () => {
    expect(walletLedger(prepareWallet())).toBeInstanceOf(MemoryLedger);
    const { w, ledger } = checkedWallet();
    expect(ledger).toBeInstanceOf(CheckedLedger);
    expect(w.ledgerChecks!.params).toEqual(DEFAULT_PROTOCOL_PARAMS[0]);
  });
});

describe('a rejected transaction', () => {
  it('changes nothing, and a corrected transaction over the same inputs passes', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const before = await snapshot(ledger);
    const wrong = buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_000_000n }], fee: 1_000n });
    const error = await rejection(ledger, signed(wrong));
    expect(error.info).toMatch(/^ConwayApplyTxError \[/);
    expect(error.info).toContain('FeeTooSmallUTxO');
    expect(error.info).toContain('ValueNotConservedUTxO');
    expect(await snapshot(ledger)).toEqual(before);
    expect(ledger.certState).toBe(before.certState);

    const corrected = buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
    const id = bytesToHex(await ledger.submit(signed(corrected)));
    expect(keys(await ledger.getWalletUtxos())).toEqual([`${id}#0`]);
    expect(ledger.inner.submitted).toHaveLength(1);
  });

  it('an unreadable transaction is InvalidRequest and leaves no record', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const noFee = bytesToHex(encode([new Map<bigint, unknown>([[0n, outpoints(utxo(0))], [1n, [[address, 9_800_000n]]]]), new Map(), true, null] as never));
    await expect(ledger.submit(hexToBytes(noFee))).rejects.toMatchObject({ code: APIErrorCode.InvalidRequest });
    await expect(ledger.submit(hexToBytes('00'))).rejects.toMatchObject({ code: APIErrorCode.InvalidRequest });
    expect(ledger.inner.submitted).toHaveLength(0);
  });

  it('a malformed certificate is InvalidRequest naming the certificate as signTx does', async () => {
    const { ledger, address, utxo } = checkedWallet();
    // [7, credential] lacks the deposit field of account_registration_deposit.
    const tx = buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [[7n, [0n, stakeHash]]]]]) });
    await expect(ledger.submit(signed(tx))).rejects.toEqual({ code: APIErrorCode.InvalidRequest, info: 'malformed certificate 7 (account_registration_deposit)' });
    expect(ledger.inner.submitted).toHaveLength(0);
  });

  it('a form the checks cannot judge is CHW_UNSUPPORTED_TX_FORM and changes nothing', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const before = await snapshot(ledger);
    const update = buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[6n, [new Map(), 0n]]]) });
    const error: unknown = await ledger.submit(signed(update)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChwError);
    expect((error as ChwError).code).toBe('CHW_UNSUPPORTED_TX_FORM');
    expect((error as ChwError).message).toContain('body key 6 (update)');
    expect(await snapshot(ledger)).toEqual(before);
  });
});

/** A UTxO at a script address, known to the wallet's ledger as foreign and to Evolution as available. */
function lockedBy(hash: ScriptHash.ScriptHash, seed: string) {
  const input = syntheticInput(seed, 0n);
  const scriptAddress = new Address.Address({ networkId: 0, paymentCredential: hash });
  const evo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address: scriptAddress, assets: Assets.fromLovelace(5_000_000n) });
  const config = { txId: bytesToHex(input.txId), index: 0, addressHex: bytesToHex(Address.toBytes(scriptAddress)), lovelace: 5_000_000 };
  return { input, evo, config };
}

describe('transactions a node accepts', () => {
  it('an Evolution-built balanced payment signed by the wallet', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const tx = await evolutionBuild((b) => b.payToAddress({ address: Address.fromBytes(otherAddress), assets: Assets.fromLovelace(2_000_000n) }), address, [evolutionUtxo(utxo(0), address)]);
    const id = await ledger.submit(hexToBytes(Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [account.payment]))));
    const now = await ledger.getWalletUtxos();
    expect(now.length).toBeGreaterThan(0);
    expect(now.every((u) => bytesToHex(u.input.txId) === bytesToHex(id))).toBe(true);
  });
});

describe('Plutus scripts run on submit', () => {
  const plutus = new PlutusV3.PlutusV3({ bytes: plutusScript('v3_always_succeeds').bytes });

  /** An Evolution-built spend of an always_succeeds output, the declared ExUnits from evaluator, signed by the wallet. */
  async function evolutionSpend(seed: string, evaluator: Evaluator) {
    const locked = lockedBy(ScriptHash.fromScript(plutus), seed);
    const { ledger, address, utxo } = checkedWallet({ utxos: [{ lovelace: 50_000_000 }, { lovelace: 10_000_000 }], foreignUtxos: [locked.config] });
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      address,
      [utxo(0), utxo(1)].map((u) => evolutionUtxo(u, address)),
      { evaluator },
    );
    return { ledger, locked, unsigned: tx, tx: hexToBytes(Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [account.payment]))) };
  }

  it('an Evolution-built always_succeeds spend passes every check with the builder\'s script data hash, declared above or exactly at what it needs', async () => {
    for (const [seed, evaluator] of [
      ['checks-plutus-above', fixedBudgetEvaluator],
      ['checks-plutus-exact', budgetEvaluator(9_751n, 2_836_913n)],
    ] as const) {
      const { ledger, locked, unsigned, tx } = await evolutionSpend(seed, evaluator);
      const csl = CSL.Transaction.from_hex(unsigned);
      expect(csl.witness_set().redeemers()?.len()).toBe(1);
      expect(csl.body().collateral()?.len()).toBeGreaterThan(0);
      expect(csl.body().script_data_hash()).toBeDefined();
      await ledger.submit(tx);
      expect(ledger.inner.unspent(locked.input)).toBeUndefined();
    }
  });

  it('declared ExUnits one below what always_succeeds needs: ValidationTagMismatch FailedUnexpectedly, nothing changes', async () => {
    const { ledger, locked, tx } = await evolutionSpend('checks-plutus-short', budgetEvaluator(9_750n, 2_836_913n));
    const before = await snapshot(ledger);
    const error = await rejection(ledger, tx);
    expect(error.info).toContain('ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "');
    expect(error.info).toContain('needs ExUnits {mem: 9751, steps: 2836913}, its redeemer declares ExUnits {mem: 9750, steps: 2836913}');
    expect(await snapshot(ledger)).toEqual(before);
    expect(ledger.inner.unspent(locked.input)).toBeDefined();
  });

  it('is_valid false with always_fails is accepted and takes only the collateral', async () => {
    const script = plutusScript('v3_always_fails');
    const locked = lockedUtxo(script, 'checks-invalid-fails');
    const { ledger, address, utxo } = checkedWallet({ foreignUtxos: [foreignConfig(locked)] });
    const tx = plutusSpend({ spends: [{ utxo: locked, script }], wallet: utxo(0), changeAddress: address, isValid: false, keys: [account.payment] });
    await ledger.submit(hexToBytes(tx));
    expect(ledger.inner.unspent(utxo(0).input)).toBeUndefined();
    expect(ledger.inner.unspent(locked.input)).toBeDefined();
    expect(await ledger.getWalletUtxos()).toEqual([]);
    expect(ledger.inner.submitted).toHaveLength(1);
  });

  it('is_valid false with always_succeeds is ValidationTagMismatch PassedUnexpectedly and changes nothing', async () => {
    const script = plutusScript('v3_always_succeeds');
    const locked = lockedUtxo(script, 'checks-invalid-succeeds');
    const { ledger, address, utxo } = checkedWallet({ foreignUtxos: [foreignConfig(locked)] });
    const before = await snapshot(ledger);
    const tx = plutusSpend({ spends: [{ utxo: locked, script }], wallet: utxo(0), changeAddress: address, isValid: false, keys: [account.payment] });
    const error = await rejection(ledger, hexToBytes(tx));
    expect(error.info).toBe('ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))]');
    expect(await snapshot(ledger)).toEqual(before);
    // The same spend marked valid passes.
    await ledger.submit(hexToBytes(plutusSpend({ spends: [{ utxo: locked, script }], wallet: utxo(0), changeAddress: address, keys: [account.payment] })));
    expect(ledger.inner.unspent(locked.input)).toBeUndefined();
  });

  it('a failing script with phase 1 failures: only the phase 1 failures, the script never runs', async () => {
    const script = plutusScript('v3_always_fails');
    const locked = lockedUtxo(script, 'checks-fails-unsigned');
    const { ledger, address, utxo } = checkedWallet({ foreignUtxos: [foreignConfig(locked)] });
    const error = await rejection(ledger, hexToBytes(plutusSpend({ spends: [{ utxo: locked, script }], wallet: utxo(0), changeAddress: address })));
    expect(error.info).toContain('MissingVKeyWitnessesUTXOW');
    expect(error.info).not.toContain('ValidationTagMismatch');
  });

  it('always_fails beside a V1 spend whose context cannot be built: CollectErrors in either script order and for either is_valid, nothing changes', async () => {
    // The change output carries an inline datum, which a PlutusV1 context cannot show. scalus would stop at
    // always_fails and never look at the V1 context. The collect phase refuses the transaction before anything runs.
    const fails = plutusScript('v3_always_fails');
    const v1 = plutusScript('v1_always_succeeds');
    const unitHash = blake2b(encode(UNIT_DATA), { dkLen: 32 });
    const at = (script: PlutusFixture, fill: number, datum?: Datum): Utxo => ({ ...lockedUtxo(script, `mixed-${fill}`, datum), input: { txId: new Uint8Array(32).fill(fill), index: 0n } });
    for (const [failsFill, v1Fill] of [
      [0x01, 0xfe],
      [0xfe, 0x01],
    ] as const) {
      const failing = at(fails, failsFill);
      const untranslatable = at(v1, v1Fill, { kind: 'hash', hash: unitHash });
      const { ledger, address, utxo } = checkedWallet({ foreignUtxos: [foreignConfig(failing), { ...foreignConfig(untranslatable), datumHash: bytesToHex(unitHash) }] });
      const before = await snapshot(ledger);
      for (const isValid of [true, false]) {
        const spends = [
          { utxo: failing, script: fails },
          { utxo: untranslatable, script: v1 },
        ];
        const tx = plutusSpend({ spends, wallet: utxo(0), changeAddress: address, changeDatum: inlineDatum(UNIT_DATA), witnessDatums: [UNIT_DATA], isValid, keys: [account.payment] });
        const error = await rejection(ledger, hexToBytes(tx));
        expect(error.info).toBe(
          'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (CollectErrors (BadTranslation (BabbageContextError (InlineDatumsNotSupported (TxOutFromOutput (TxIx 0)))) :| []))))]',
        );
        expect(await snapshot(ledger)).toEqual(before);
      }
    }
  });
});

describe('stake registration in Node and in the certificate state', () => {
  const registration = [7n, [0n, stakeHash], 2_000_000n];
  const unregistration = [8n, [0n, stakeHash], 2_000_000n];
  const voteDelegation = [9n, [0n, stakeHash], [0n, drepHash]];
  const withStake = [account.payment, account.stake];

  it('agree after every submit: rejected delegation, invalid transaction, register and unregister at once, registration, delegation', async () => {
    const alwaysFails = plutusScript('v3_always_fails');
    const locked = lockedUtxo(alwaysFails, 'agree-locked');
    const { ledger, address, utxo } = checkedWallet({ utxos: [10_000_000, 10_000_000, 10_000_000, 10_000_000, 5_000_000].map((lovelace) => ({ lovelace })), foreignUtxos: [foreignConfig(locked)] });
    const agree = async (registered: boolean) => {
      expect(await ledger.getStakeRegistered()).toBe(registered);
      expect(ledger.certState.accounts.has(ownStake)).toBe(registered);
    };

    // The demo dApp's vote delegation spends UTxO 0 of the default wallet, a fresh stake key is not registered.
    const demo = DEMO.DEMO_DELEG_TX.unsignedHex;
    const error = await rejection(ledger, signed(demo, withStake));
    expect(error.info).toContain('StakeKeyNotRegisteredDELEG');
    expect(error.info).not.toContain('UtxoFailure');
    await agree(false);

    // is_valid false with a script that fails: only the collateral is spent, the registration does not apply.
    // The body still balances with the deposit.
    const { witnessSet, scriptDataHash } = scriptWitnesses([{ utxo: locked, script: alwaysFails }], [utxo(1), locked]);
    const invalid = withVKeys(
      {
        inputs: [utxo(1).input, locked.input],
        outputs: [{ address, lovelace: 12_800_000n }],
        fee: 200_000n,
        isValid: false,
        witnessSet,
        extraBodyEntries: new Map<bigint, unknown>([
          [4n, [registration]],
          [11n, scriptDataHash],
          [13n, outpoints(utxo(4))],
        ]),
      },
      withStake,
    );
    await ledger.submit(hexToBytes(invalid));
    expect(ledger.inner.unspent(utxo(4).input)).toBeUndefined();
    expect(ledger.inner.unspent(locked.input)).toBeDefined();
    await agree(false);

    // Registered and unregistered in one transaction: the refund equals the deposit paid in the same transaction.
    const both = buildTx({ inputs: [utxo(2).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [registration, unregistration]]]) });
    await ledger.submit(signed(both, withStake));
    await agree(false);

    const register = buildTx({ inputs: [utxo(3).input], outputs: [{ address, lovelace: 7_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [registration]]]) });
    await ledger.submit(signed(register, withStake));
    await agree(true);
    expect(ledger.certState.accounts.get(ownStake)).toBe(2_000_000n);

    const delegate = buildTx({ inputs: [utxo(1).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [voteDelegation]]]) });
    await ledger.submit(signed(delegate, withStake));
    await agree(true);
  });

  it('stakeRegistered: true starts with the key deposit, an unregistration refunds it', async () => {
    const { ledger, address, utxo } = checkedWallet({ stakeRegistered: true });
    expect(ledger.certState.accounts.get(ownStake)).toBe(DEFAULT_PROTOCOL_PARAMS[0].keyDeposit);
    const tx = buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 11_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [unregistration]]]) });
    await ledger.submit(signed(tx, withStake));
    expect(await ledger.getStakeRegistered()).toBe(false);
    expect(ledger.certState.accounts.has(ownStake)).toBe(false);
  });
});

describe('concurrent submits', () => {
  const registration = [7n, [0n, stakeHash], 2_000_000n];
  const unregistration = [8n, [0n, stakeHash], 2_000_000n];
  const withStake = [account.payment, account.stake];
  const twoUtxos = [{ lovelace: 10_000_000 }, { lovelace: 10_000_000 }];

  /** Both submits start before either settles, the way a dApp firing twice would. */
  async function race(ledger: CheckedLedger, first: Uint8Array, second: Uint8Array) {
    const results = await Promise.allSettled([ledger.submit(first), ledger.submit(second)]);
    // One submit at a time, in the order they came: the first passes, the second sees its effect.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const reason: unknown = (results[1] as PromiseRejectedResult).reason;
    expect(isCip30Error(reason)).toBe(true);
    expect(reason).toMatchObject({ code: TxSendErrorCode.Failure });
    expect(ledger.inner.submitted).toHaveLength(1);
    return (reason as Cip30Error).info;
  }

  it('two registrations of the own stake key from separate inputs: one passes, the other is StakeKeyRegisteredDELEG', async () => {
    const { ledger, address, utxo } = checkedWallet({ utxos: twoUtxos });
    const register = (i: number) => signed(buildTx({ inputs: [utxo(i).input], outputs: [{ address, lovelace: 7_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [registration]]]) }), withStake);
    expect(await race(ledger, register(0), register(1))).toContain('StakeKeyRegisteredDELEG');
    expect(await ledger.getStakeRegistered()).toBe(true);
    expect(ledger.certState.accounts.get(ownStake)).toBe(2_000_000n);
  });

  it('two unregistrations of the own stake key from separate inputs: one refund, the other is StakeKeyNotRegisteredDELEG', async () => {
    const { ledger, address, utxo } = checkedWallet({ utxos: twoUtxos, stakeRegistered: true });
    const unregister = (i: number) => signed(buildTx({ inputs: [utxo(i).input], outputs: [{ address, lovelace: 11_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[4n, [unregistration]]]) }), withStake);
    const info = await race(ledger, unregister(0), unregister(1));
    expect(info).toContain('StakeKeyNotRegisteredDELEG');
    // The second refund is 0 once the key is gone, so its outputs no longer balance.
    expect(info).toContain('ValueNotConservedUTxO');
    expect(await ledger.getStakeRegistered()).toBe(false);
    expect(ledger.certState.accounts.has(ownStake)).toBe(false);
  });

  it('a refused submit does not hold up the next one', async () => {
    const { ledger, address, utxo } = checkedWallet({ utxos: twoUtxos });
    const wrong = signed(buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_000_000n }], fee: 200_000n }));
    const right = signed(buildTx({ inputs: [utxo(1).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n }));
    const results = await Promise.allSettled([ledger.submit(wrong), ledger.submit(right)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(ledger.inner.submitted).toHaveLength(1);
  });
});

describe('chained and repeated submits', () => {
  it('a second transaction spends the change of the first', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const firstId = await ledger.submit(signed(buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n })));
    const second = buildTx({ inputs: [{ txId: firstId, index: 0n }], outputs: [{ address, lovelace: 9_600_000n }], fee: 200_000n });
    const secondId = await ledger.submit(signed(second));
    expect(keys(await ledger.getWalletUtxos())).toEqual([`${bytesToHex(secondId)}#0`]);
  });

  it('the same transaction twice: the second submit is ConwayMempoolFailure alone and changes nothing', async () => {
    const { ledger, address, utxo } = checkedWallet();
    const tx = signed(buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n }));
    await ledger.submit(tx);
    const before = await snapshot(ledger);
    const error = await rejection(ledger, tx);
    expect(error.info).toContain('ConwayMempoolFailure');
    expect(error.info).not.toContain('BadInputsUTxO');
    expect(await snapshot(ledger)).toEqual(before);
  });

  it('currentSlot at or after the ttl is OutsideValidityIntervalUTxO', async () => {
    const { ledger, address, utxo } = checkedWallet({ ledger: { currentSlot: 1_000 } });
    const withTtl = (ttl: bigint) => signed(buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[3n, ttl]]) }));
    expect((await rejection(ledger, withTtl(1_000n))).info).toContain('OutsideValidityIntervalUTxO');
    await ledger.submit(withTtl(1_001n));
  });
});

describe('a page wallet on a checked host ledger', () => {
  function pageWallet() {
    const w = prepareWallet({ ledger: { checks: true } });
    const ledger = walletLedger(w);
    const page = pageWith(ledger);
    installWallet({ ...w.config, ledger: { ...w.config.ledger!, binding: LEDGER_BINDING } }, page);
    return { w, ledger, page, address: parseAddressArg(w.addresses.payment) };
  }

  it('the demo commit, signed in the page, passes and the host ledger holds its output', async () => {
    const { ledger, page } = pageWallet();
    const api = await enableChw(page);
    const { unsignedHex } = DEMO.DEMO_TX;
    const id = await api.submitTx(spliceWitnessSet(unsignedHex, await api.signTx(unsignedHex, false)));
    expect(keys(await ledger.getWalletUtxos())).toEqual([`${id}#0`]);
  });

  it('a rejection reaches the dApp as a plain TxSendError and the journal records it', async () => {
    const { w, ledger, page, address } = pageWallet();
    const api = await enableChw(page);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const unbalanced = buildTx({ inputs: [utxo0.input], outputs: [{ address, lovelace: 9_000_000n }], fee: 200_000n });
    const error: unknown = await api.submitTx(spliceWitnessSet(unbalanced, await api.signTx(unbalanced, false))).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: TxSendErrorCode.Failure, info: expect.stringContaining('ValueNotConservedUTxO') });
    expect(page.__chw!.journal.at(-1)).toMatchObject({ method: 'submitTx', error: { code: TxSendErrorCode.Failure } });
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([utxo0]));
  });

  it('a form the checks cannot judge reaches the page as ChwError with its code once', async () => {
    const { w, page, address } = pageWallet();
    const api = await enableChw(page);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    // Signed in Node: signTx at partialSign false refuses this form before submitTx could.
    const update = buildTx({ inputs: [utxo0.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[6n, [new Map(), 0n]]]) });
    const error: unknown = await api.submitTx(bytesToHex(signed(update))).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChwError);
    expect((error as ChwError).message.match(/CHW_UNSUPPORTED_TX_FORM/g)).toHaveLength(1);
  });
});
