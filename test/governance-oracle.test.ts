import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { readFileSync } from 'node:fs';
import { Address, Anchor, Assets, Credential, DRep, KeyHash, Transaction, TransactionHash, Url, UTxO, VotingProcedures, GovernanceAction } from '@evolution-sdk/evolution';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { preprod } from '@evolution-sdk/evolution/sdk/client/Chain';
import type { ProtocolParameters } from '@evolution-sdk/evolution/sdk/provider/Provider';
import { bech32 } from '@scure/base';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { deriveAccount } from '../src/derive/index.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { cslGovernanceTx, cslVerifiedKeys, cslVerifiedKeysOfTx, cslWitnessCount, mergeWitnessSets, type CslCert } from './helpers/csl-governance.js';
import { spliceWitnessSet } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';
import { MNEMONIC } from './fixtures/vectors.js';

const w = prepareWallet();
const address = Uint8Array.from(bech32.fromWords(bech32.decode(w.addresses.payment, false).words));
const rewardHex = bytesToHex(Uint8Array.from(bech32.fromWords(bech32.decode(w.addresses.reward, false).words)));
const utxo = syntheticOwnedUtxo('chw', 0, address, 10_000_000n);
const input = { txId: utxo.input.txId, index: 0 };
const stakeCred = (C: typeof CSL) => C.Credential.from_keyhash(C.Ed25519KeyHash.from_bytes(hexToBytes(rewardHex).slice(1)));
const drepCred = (C: typeof CSL) => C.Credential.from_keyhash(C.Ed25519KeyHash.from_bytes(hexToBytes(w.drepKeyHashHex)));
const ownDrep = (C: typeof CSL) => C.DRep.new_key_hash(C.Ed25519KeyHash.from_bytes(hexToBytes(w.drepKeyHashHex)));
const pool = (C: typeof CSL) => C.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(5));
const anchor = (C: typeof CSL) => C.Anchor.new(C.URL.new('https://example.com/d.json'), C.AnchorDataHash.from_bytes(new Uint8Array(32)));
const two = (C: typeof CSL) => C.BigNum.from_str('2000000');
const five = (C: typeof CSL) => C.BigNum.from_str('500000000');

// Expected signer roles per certificate, from the witness table of the spec.
const cases: Array<[string, CslCert, Array<'payment' | 'stake' | 'drep'>]> = [
  ['0 account_registration', (C) => C.Certificate.new_stake_registration(C.StakeRegistration.new(stakeCred(C))), ['payment']],
  ['1 account_unregistration', (C) => C.Certificate.new_stake_deregistration(C.StakeDeregistration.new(stakeCred(C))), ['payment', 'stake']],
  ['2 delegation_to_stake_pool', (C) => C.Certificate.new_stake_delegation(C.StakeDelegation.new(stakeCred(C), pool(C))), ['payment', 'stake']],
  ['7 account_registration_deposit', (C) => C.Certificate.new_stake_registration(C.StakeRegistration.new_with_explicit_deposit(stakeCred(C), two(C))), ['payment', 'stake']],
  ['8 account_unregistration_deposit', (C) => C.Certificate.new_stake_deregistration(C.StakeDeregistration.new_with_explicit_refund(stakeCred(C), two(C))), ['payment', 'stake']],
  ['9 delegation_to_drep', (C) => C.Certificate.new_vote_delegation(C.VoteDelegation.new(stakeCred(C), ownDrep(C))), ['payment', 'stake']],
  ['10 delegation_to_stake_pool_and_drep', (C) => C.Certificate.new_stake_and_vote_delegation(C.StakeAndVoteDelegation.new(stakeCred(C), pool(C), ownDrep(C))), ['payment', 'stake']],
  ['11 account_registration_delegation_to_stake_pool', (C) => C.Certificate.new_stake_registration_and_delegation(C.StakeRegistrationAndDelegation.new(stakeCred(C), pool(C), two(C))), ['payment', 'stake']],
  ['12 account_registration_delegation_to_drep', (C) => C.Certificate.new_vote_registration_and_delegation(C.VoteRegistrationAndDelegation.new(stakeCred(C), ownDrep(C), two(C))), ['payment', 'stake']],
  ['13 account_registration_delegation_to_stake_pool_and_drep', (C) => C.Certificate.new_stake_vote_registration_and_delegation(C.StakeVoteRegistrationAndDelegation.new(stakeCred(C), pool(C), ownDrep(C), two(C))), ['payment', 'stake']],
  ['16 drep_registration', (C) => C.Certificate.new_drep_registration(C.DRepRegistration.new_with_anchor(drepCred(C), five(C), anchor(C))), ['payment', 'drep']],
  ['17 drep_unregistration', (C) => C.Certificate.new_drep_deregistration(C.DRepDeregistration.new(drepCred(C), five(C))), ['payment', 'drep']],
  ['18 drep_update', (C) => C.Certificate.new_drep_update(C.DRepUpdate.new_with_anchor(drepCred(C), anchor(C))), ['payment', 'drep']],
];

const roleKey = { payment: w.paymentPublicKeyHex, stake: w.stakePublicKeyHex, drep: w.drepPublicKeyHex };

async function walletApi() {
  const target: InstallTarget = {};
  installWallet(w.config, target);
  return enableChw(target);
}

const idOf = (hex: string) => CSL.FixedTransaction.from_hex(hex).transaction_hash().to_hex();

/**
 * The full check of exit criterion 1: the wallet's witnesses verify with CSL,
 * Evolution merges them without changing the transaction id, and after the
 * merge every expected witness (foreign ones included) is present and valid.
 */
async function signMergeAndCheck(tx: string, expectedKeys: string[], foreignKeys: string[] = [], merger: 'evolution' | 'splice' = 'evolution') {
  const ws = await (await walletApi()).signTx(tx, false);
  expect(cslVerifiedKeys(tx, ws).sort()).toEqual([...expectedKeys].sort());
  // Our splice replaces the witness set, so it must carry the foreign witnesses already in tx as well.
  const merged = merger === 'evolution' ? Transaction.addVKeyWitnessesHex(tx, ws) : spliceWitnessSet(tx, mergeWitnessSets(tx, ws));
  expect(idOf(merged)).toBe(idOf(tx));
  const all = [...expectedKeys, ...foreignKeys].sort();
  expect(cslVerifiedKeysOfTx(merged).sort()).toEqual(all);
  expect(cslWitnessCount(merged)).toBe(all.length);
}

// Foreign signers for the pool and committee rows. CIP-95 forbids the wallet to
// witness them, so a green test needs their witnesses to be present already.
const operator = deriveAccount(MNEMONIC, 4).payment;
const coldKey = deriveAccount(MNEMONIC, 5).payment;
const owner = deriveAccount(MNEMONIC, 6).stake;
const hashOf = (k: typeof operator) => keyHash(publicKey(k));
const pubHex = (k: typeof operator) => bytesToHex(publicKey(k));
const kh = (C: typeof CSL, k: typeof operator) => C.Ed25519KeyHash.from_bytes(hashOf(k));

const poolRegistration: CslCert = (C) => {
  const owners = C.Ed25519KeyHashes.new();
  owners.add(kh(C, owner));
  const reward = C.RewardAddress.new(0, C.Credential.from_keyhash(kh(C, owner)));
  const params = C.PoolParams.new(kh(C, operator), C.VRFKeyHash.from_bytes(new Uint8Array(32)), C.BigNum.from_str('1'), C.BigNum.from_str('340000000'), C.UnitInterval.new(C.BigNum.from_str('0'), C.BigNum.from_str('1')), reward, owners, C.Relays.new(), undefined);
  return C.Certificate.new_pool_registration(C.PoolRegistration.new(params));
};
const committeeAuth: CslCert = (C) => C.Certificate.new_committee_hot_auth(C.CommitteeHotAuth.new(C.Credential.from_keyhash(kh(C, coldKey)), C.Credential.from_keyhash(C.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(9)))));
const committeeResign: CslCert = (C) => C.Certificate.new_committee_cold_resign(C.CommitteeColdResign.new(C.Credential.from_keyhash(kh(C, coldKey))));
const poolRetirement: CslCert = (C) => C.Certificate.new_pool_retirement(C.PoolRetirement.new(kh(C, operator), 300));

describe('governance signing agrees with CSL and survives an Evolution merge', () => {
  it.each(cases)('certificate %s', async (_name, cert, roles) => {
    await signMergeAndCheck(cslGovernanceTx({ input, certificates: [cert] }), roles.map((r) => roleKey[r]));
  });

  it('a DRep vote', async () => {
    await signMergeAndCheck(cslGovernanceTx({ input, drepVote: hexToBytes(w.drepKeyHashHex) }), [roleKey.payment, roleKey.drep]);
  });

  it('an info action proposal needs only the input witness', async () => {
    await signMergeAndCheck(cslGovernanceTx({ input, infoProposal: { rewardAddressHex: rewardHex } }), [roleKey.payment]);
  });

  // Pool registration goes through our splice: Evolution 0.5.x cannot parse a
  // pool registration whose pool_owners set carries tag 258, see the pinning
  // test below and docs/known-consumer-issues.md.
  it.each([
    ['3 pool_registration', poolRegistration, [operator, owner], 'splice'],
    ['4 pool_retirement', poolRetirement, [operator], 'evolution'],
    ['14 committee_authorization', committeeAuth, [coldKey], 'evolution'],
    ['15 committee_resignation', committeeResign, [coldKey], 'evolution'],
  ] as const)('certificate %s: both partialSign values, uncovered and covered', async (_name, cert, foreign, merger) => {
    const unsigned = cslGovernanceTx({ input, certificates: [cert] });
    const api = await walletApi();
    // uncovered: ProofGeneration at false, only the payment witness at true
    await expect(api.signTx(unsigned, false)).rejects.toEqual(expect.objectContaining({ code: 1 }));
    expect(cslVerifiedKeys(unsigned, await api.signTx(unsigned, true))).toEqual([roleKey.payment]);
    // covered: the wallet adds only its payment witness at both values
    const preSigned = spliceWitnessSet(unsigned, signWithKeys(unsigned, [...foreign]));
    expect(cslVerifiedKeys(preSigned, await api.signTx(preSigned, true))).toEqual([roleKey.payment]);
    await signMergeAndCheck(preSigned, [roleKey.payment], foreign.map(pubHex), merger);
  });

  it('pins a consumer issue: Evolution 0.5.x cannot parse a pool registration with a tag 258 owner set', () => {
    // Valid Conway CDDL (pool_owners : set<addr_keyhash>) and CSL's default encoding.
    // When this starts passing through, Evolution fixed it: drop the splice above and the known-consumer-issues entry.
    const tx = cslGovernanceTx({ input, certificates: [poolRegistration] });
    expect(() => Transaction.addVKeyWitnessesHex(tx, signWithKeys(tx, [operator]))).toThrow();
  });
});

// Recorded once from Koios preprod (see docs/recipes.md, "Protocol parameters offline"), so the builder runs without a network.
interface KoiosEpochParams {
  min_fee_a: number; min_fee_b: number; max_tx_size: number; max_val_size: number;
  key_deposit: string; pool_deposit: string; drep_deposit: string; gov_action_deposit: string;
  price_mem: number; price_step: number; max_tx_ex_mem: number; max_tx_ex_steps: number;
  coins_per_utxo_size: string; collateral_percent: number; max_collateral_inputs: number;
  min_fee_ref_script_cost_per_byte: number; cost_models: Record<'PlutusV1' | 'PlutusV2' | 'PlutusV3', number[]>;
}

/** Koios epoch_params field names to Evolution's Provider.ProtocolParameters. */
function toEvolutionParams(k: KoiosEpochParams): ProtocolParameters {
  const model = (costs: number[]) => Object.fromEntries(costs.map((c, i) => [String(i), c]));
  return {
    minFeeA: k.min_fee_a, minFeeB: k.min_fee_b, maxTxSize: k.max_tx_size, maxValSize: k.max_val_size,
    keyDeposit: BigInt(k.key_deposit), poolDeposit: BigInt(k.pool_deposit), drepDeposit: BigInt(k.drep_deposit), govActionDeposit: BigInt(k.gov_action_deposit),
    priceMem: k.price_mem, priceStep: k.price_step, maxTxExMem: BigInt(k.max_tx_ex_mem), maxTxExSteps: BigInt(k.max_tx_ex_steps),
    coinsPerUtxoByte: BigInt(k.coins_per_utxo_size), collateralPercentage: k.collateral_percent, maxCollateralInputs: k.max_collateral_inputs,
    minFeeRefScriptCostPerByte: k.min_fee_ref_script_cost_per_byte,
    costModels: { PlutusV1: model(k.cost_models.PlutusV1), PlutusV2: model(k.cost_models.PlutusV2), PlutusV3: model(k.cost_models.PlutusV3) },
  };
}

const koios = (JSON.parse(readFileSync(new URL('./fixtures/koios-epoch-params-preprod.json', import.meta.url), 'utf8')) as KoiosEpochParams[])[0]!;

async function evolutionBuild(configure: (b: ReturnType<typeof makeTxBuilder>) => void): Promise<string> {
  const builder = makeTxBuilder({ chain: preprod });
  configure(builder);
  const built = await builder.build({
    changeAddress: Address.fromBytes(address),
    availableUtxos: [
      new UTxO.UTxO({
        transactionId: TransactionHash.fromBytes(utxo.input.txId),
        index: 0n,
        address: Address.fromBytes(address),
        assets: Assets.fromLovelace(utxo.lovelace),
      }),
    ],
    fullProtocolParameters: toEvolutionParams(koios),
  });
  return Transaction.toCBORHex(await built.toTransaction());
}

describe('Evolution-built governance transactions', () => {
  const stake = Credential.makeKeyHash(hexToBytes(rewardHex).slice(1));
  const drepHash = KeyHash.fromHex(w.drepKeyHashHex);
  const drepCredential = Credential.makeKeyHash(hexToBytes(w.drepKeyHashHex));

  it('delegateToDRep', async () => {
    const tx = await evolutionBuild((b) => b.delegateToDRep({ stakeCredential: stake, drep: DRep.fromKeyHash(drepHash) }));
    await signMergeAndCheck(tx, [roleKey.payment, roleKey.stake]);
  });

  it('vote', async () => {
    const tx = await evolutionBuild((b) =>
      b.vote({
        votingProcedures: VotingProcedures.singleVote(
          new VotingProcedures.DRepVoter({ drep: DRep.fromKeyHash(drepHash) }),
          new GovernanceAction.GovActionId({ transactionId: TransactionHash.fromBytes(new Uint8Array(32).fill(3)), govActionIndex: 0n }),
          new VotingProcedures.VotingProcedure({ vote: VotingProcedures.yes(), anchor: null }),
        ),
      }),
    );
    await signMergeAndCheck(tx, [roleKey.payment, roleKey.drep]);
  });

  it('updateDRep', async () => {
    const anchor = new Anchor.Anchor({ anchorUrl: new Url.Url({ href: 'https://example.com/d.json' }), anchorDataHash: new Uint8Array(32) });
    const tx = await evolutionBuild((b) => b.updateDRep({ drepCredential, anchor }));
    await signMergeAndCheck(tx, [roleKey.payment, roleKey.drep]);
  });
});
