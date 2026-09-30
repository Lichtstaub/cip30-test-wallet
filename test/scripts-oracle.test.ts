import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Credential, Data, NativeScripts, PlutusV3, ScriptHash, Transaction, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { bytesToHex } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { prepareWallet, type WalletOptions } from '../src/host/config.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { cslGovernanceTx, cslTxId, cslVerifiedKeys, cslVerifiedKeysOfTx } from './helpers/csl-governance.js';
import { evolutionBuild, fixedBudgetEvaluator } from './helpers/evolution-build.js';
import { enableChw } from './helpers/page.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const OWN = [{ lovelace: 50_000_000 }, { lovelace: 10_000_000 }];
const w = prepareWallet({ utxos: OWN });
const address = parseAddressArg(w.addresses.payment);
const paymentHash = address.slice(1, 29);
const stakeHash = parseAddressArg(w.addresses.reward).slice(1);
const other = deriveAccount(MNEMONIC, 1);
const third = deriveAccount(MNEMONIC, 2);
const otherPub = bytesToHex(publicKey(other.payment));
const own = OWN.map((u, i) => syntheticOwnedUtxo(w.config.name, i, address, BigInt(u.lovelace)));
const ownEvo = own.map(
  (u) => new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(u.input.txId), index: u.input.index, address: Address.fromBytes(address), assets: Assets.fromLovelace(u.lovelace) }),
);
// A Plutus V3 script, never executed: fixedBudgetEvaluator stands in for the node.
const plutus = new PlutusV3.PlutusV3({ bytes: Uint8Array.from([0x46, 0x01, 0x00, 0x00, 0x22, 0x49, 0x9d]) });
const plutusHash = ScriptHash.fromScript(plutus);
const pk = (hash: Uint8Array) => NativeScripts.makeScriptPubKey(hash).script;

/** A UTxO at a script address, known to the wallet's ledger as foreign and to Evolution as available. */
function lockedBy(hash: ScriptHash.ScriptHash, seed: string, scriptRef?: PlutusV3.PlutusV3) {
  const input = syntheticInput(seed, 0n);
  const scriptAddress = new Address.Address({ networkId: 0, paymentCredential: hash });
  const evo = new UTxO.UTxO({
    transactionId: TransactionHash.fromBytes(input.txId),
    index: 0n,
    address: scriptAddress,
    assets: Assets.fromLovelace(5_000_000n),
    ...(scriptRef ? { scriptRef } : {}),
  });
  const config = {
    txId: bytesToHex(input.txId),
    index: 0,
    addressHex: bytesToHex(Address.toBytes(scriptAddress)),
    lovelace: 5_000_000,
    ...(scriptRef ? { scriptRef: bytesToHex(encode([3n, scriptRef.bytes])) } : {}),
  };
  return { evo, config };
}

async function walletApi(foreignUtxos: NonNullable<WalletOptions['foreignUtxos']> = []) {
  const target: InstallTarget = {};
  installWallet(prepareWallet({ utxos: OWN, foreignUtxos }).config, target);
  return enableChw(target);
}

/**
 * The wallet's witnesses verify with CSL, Evolution merges them without
 * changing the transaction id, and after the merge every expected key
 * (co-signers included) verifies in the complete transaction.
 */
function expectSigned(tx: string, witnessSet: string, expected: string[], coSigners: string[] = []): void {
  expect(cslVerifiedKeys(tx, witnessSet).sort()).toEqual([...expected].sort());
  const merged = Transaction.addVKeyWitnessesHex(tx, witnessSet);
  expect(cslTxId(merged)).toBe(cslTxId(tx));
  expect(cslVerifiedKeysOfTx(merged).sort()).toEqual([...expected, ...coSigners].sort());
}

// Evolution 0.5.13 recognises a native script input only when the script is attached before
// collectFrom, otherwise it asks for a redeemer. It builds no native script withdrawal at all
// (it demands a redeemer for every script credential), so that one is built by CSL.
describe('script transactions built by Evolution and CSL', () => {
  it('a Plutus V3 spend with collateral: only the payment key, for the fee input and the collateral', async () => {
    const locked = lockedBy(plutusHash, 'oracle-plutus');
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      address,
      ownEvo,
      { evaluator: fixedBudgetEvaluator },
    );
    const body = CSL.Transaction.from_hex(tx).body();
    expect(body.collateral()?.len()).toBeGreaterThan(0);
    expect(body.script_data_hash()).toBeDefined();
    expect(CSL.Transaction.from_hex(tx).witness_set().redeemers()?.len()).toBe(1);
    expectSigned(tx, await (await walletApi([locked.config])).signTx(tx, false), [w.paymentPublicKeyHex]);
  });

  it('native 2 of 3 with a co-signer: ProofGeneration alone, the wallet adds its share to the co-signed transaction', async () => {
    const script = NativeScripts.makeScriptNOfK(2n, [pk(paymentHash), pk(keyHash(publicKey(other.payment))), pk(keyHash(publicKey(third.payment)))]);
    const locked = lockedBy(ScriptHash.fromScript(script), 'oracle-2of3');
    const tx = await evolutionBuild((b) => b.attachScript({ script }).collectFrom({ inputs: [locked.evo] }), address, ownEvo);
    const api = await walletApi([locked.config]);
    await expect(api.signTx(tx, false)).rejects.toEqual(expect.objectContaining({ code: 1 }));
    const coSigned = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [other.payment]));
    expectSigned(coSigned, await api.signTx(coSigned, false), [w.paymentPublicKeyHex], [otherPub]);
  });

  it('native any with two different satisfying sets: the wallet keys alone, or a co-signer', async () => {
    const script = NativeScripts.makeScriptAny([NativeScripts.makeScriptAll([pk(paymentHash), pk(stakeHash)]).script, pk(keyHash(publicKey(other.payment)))]);
    const locked = lockedBy(ScriptHash.fromScript(script), 'oracle-any');
    const tx = await evolutionBuild((b) => b.attachScript({ script }).collectFrom({ inputs: [locked.evo] }), address, ownEvo);
    const api = await walletApi([locked.config]);
    const ownKeys = [w.paymentPublicKeyHex, w.stakePublicKeyHex];
    expectSigned(tx, await api.signTx(tx, false), ownKeys);
    const coSigned = Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [other.payment]));
    expectSigned(coSigned, await api.signTx(coSigned, false), ownKeys, [otherPub]);
  });

  it('a native mint under a policy with the wallet stake key: payment and stake', async () => {
    const policy = NativeScripts.makeScriptAll([pk(stakeHash)]);
    const policyId = ScriptHash.toHex(ScriptHash.fromScript(policy));
    const tx = await evolutionBuild((b) => b.attachScript({ script: policy }).mintAssets({ assets: Assets.fromHexStrings(policyId, '41', 5n) }), address, ownEvo);
    expect(CSL.Transaction.from_hex(tx).body().mint()?.len()).toBe(1);
    expectSigned(tx, await (await walletApi()).signTx(tx, false), [w.paymentPublicKeyHex, w.stakePublicKeyHex]);
  });

  it('a Plutus spend whose script is the reference script of a reference input', async () => {
    const locked = lockedBy(plutusHash, 'oracle-ref-locked');
    const holder = lockedBy(plutusHash, 'oracle-ref-holder', plutus);
    const tx = await evolutionBuild(
      (b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).readFrom({ referenceInputs: [holder.evo] }),
      address,
      ownEvo,
      { evaluator: fixedBudgetEvaluator },
    );
    expect(CSL.Transaction.from_hex(tx).witness_set().plutus_scripts()).toBeUndefined();
    expect(CSL.Transaction.from_hex(tx).body().reference_inputs()?.len()).toBe(1);
    expect(CSL.Transaction.from_hex(tx).witness_set().redeemers()?.len()).toBe(1);
    expectSigned(tx, await (await walletApi([locked.config, holder.config])).signTx(tx, false), [w.paymentPublicKeyHex]);
    await expect((await walletApi([locked.config])).signTx(tx, false)).rejects.toThrow(/CHW_UNRESOLVED_INPUT: reference input/);
  });

  it('withdrawals from a native script credential with the wallet stake key (CSL) and from a Plutus credential (Evolution)', async () => {
    const script = NativeScripts.makeScriptAll([pk(stakeHash)]);
    const scriptBytes = NativeScripts.toCBORBytes(script);
    const rewardAddressHex = 'f0' + ScriptHash.toHex(ScriptHash.fromScript(script));
    const native = cslGovernanceTx({ input: { txId: own[0]!.input.txId, index: 0 }, scriptWithdrawal: { rewardAddressHex, nativeScript: scriptBytes } });
    // CSL-built like the guardrail case below, checked with CSL alone, without an Evolution merge.
    expect(cslVerifiedKeys(native, await (await walletApi()).signTx(native, false)).sort()).toEqual([w.paymentPublicKeyHex, w.stakePublicKeyHex].sort());
    const plutusWithdrawal = await evolutionBuild(
      (b) => b.withdraw({ stakeCredential: Credential.makeScriptHash(ScriptHash.toBytes(plutusHash)), amount: 0n, redeemer: Data.constr(0n, []) }).attachScript({ script: plutus }),
      address,
      ownEvo,
      { evaluator: fixedBudgetEvaluator },
    );
    expect(CSL.Transaction.from_hex(plutusWithdrawal).body().withdrawals()?.len()).toBe(1);
    expect(CSL.Transaction.from_hex(plutusWithdrawal).witness_set().redeemers()?.len()).toBe(1);
    expectSigned(plutusWithdrawal, await (await walletApi()).signTx(plutusWithdrawal, false), [w.paymentPublicKeyHex]);
  });

  it('a parameter change with a guardrail script, built by CSL: the payment key only, CHW_UNRESOLVED_SCRIPT without the script', async () => {
    const input = { txId: own[0]!.input.txId, index: 0 };
    const guardrailProposal = { rewardAddressHex: bytesToHex(parseAddressArg(w.addresses.reward)), policyHash: ScriptHash.toBytes(plutusHash) };
    const tx = cslGovernanceTx({ input, guardrailProposal, plutusV3: plutus.bytes });
    expect(cslVerifiedKeys(tx, await (await walletApi()).signTx(tx, false))).toEqual([w.paymentPublicKeyHex]);
    await expect((await walletApi()).signTx(cslGovernanceTx({ input, guardrailProposal }), false)).rejects.toThrow(/CHW_UNRESOLVED_SCRIPT: proposal 0 \(parameter_change\)/);
  });
});
