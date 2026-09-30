import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { requirements } from '../src/core/requirements.js';
import { credentialKey, headerNetwork, readTransaction, type CertFact } from '../src/host/checks/read-tx.js';
import { buildTx, TEST_ADDRESS } from './helpers/build-tx.js';
import { cslGovernanceTx, type CslCert } from './helpers/csl-governance.js';
import { hash28, POLICY, syntheticInput } from './helpers/synthetic.js';

const input = syntheticInput('tx-facts', 0n);
const out = [{ address: TEST_ADDRESS, lovelace: 2_000_000n }];
const factsOf = (tx: string | Uint8Array) => {
  const bytes = typeof tx === 'string' ? hexToBytes(tx) : tx;
  return readTransaction(bytes, parseTransaction(bytes));
};
const withBody = (entries: Array<[bigint, unknown]>, witnessSet?: Map<bigint, unknown>) =>
  buildTx({ inputs: [input], outputs: out, fee: 200_000n, extraBodyEntries: new Map(entries), ...(witnessSet ? { witnessSet } : {}) });
const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const keyCred = { isScript: false, hash: hash28(1) };
const scriptCred = { isScript: true, hash: hash28(2) };
const anchor = ['https://example.com/a.json', new Uint8Array(32)];
/** buildTx writes null as auxiliary data, its last byte. This puts the given item there. */
const withAux = (txHex: string, aux: Uint8Array) => concat(hexToBytes(txHex).slice(0, -1), aux);

describe('readTransaction: amounts and sizes', () => {
  it('reads fee, outputs with their sizes, total collateral, network id, treasury value and donation from a transaction CSL built', () => {
    const address = CSL.Address.from_bytes(TEST_ADDRESS);
    const plain = CSL.TransactionOutput.new(address, CSL.Value.new(big(2_000_000)));
    const names = CSL.Assets.new();
    names.insert(CSL.AssetName.new(hexToBytes('41')), big(5));
    names.insert(CSL.AssetName.new(hexToBytes('')), big(7));
    const multiasset = CSL.MultiAsset.new();
    multiasset.insert(CSL.ScriptHash.from_bytes(hexToBytes(POLICY)), names);
    const withAssets = CSL.TransactionOutput.new(address, CSL.Value.new_with_assets(big(3_000_000), multiasset));
    withAssets.set_plutus_data(CSL.PlutusData.new_integer(CSL.BigInt.from_str('42')));
    const outputs = CSL.TransactionOutputs.new();
    outputs.add(plain);
    outputs.add(withAssets);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, outputs, big(171_000));
    body.set_collateral_return(plain);
    body.set_total_collateral(big(5_000_000));
    body.set_network_id(CSL.NetworkId.testnet());
    body.set_current_treasury_value(big(123));
    body.set_donation(big(456));
    const metadata = CSL.GeneralTransactionMetadata.new();
    metadata.insert(big(674), CSL.TransactionMetadatum.new_text('hello'));
    const aux = CSL.AuxiliaryData.new();
    aux.set_metadata(metadata);
    const tx = CSL.Transaction.new(body, CSL.TransactionWitnessSet.new(), aux);
    const bytes = tx.to_bytes();
    const facts = factsOf(bytes);

    expect(bytes[0]).toBe(0x84);
    expect(facts.size).toBe(BigInt(bytes.length - 1));
    expect(facts.fee).toBe(171_000n);
    expect(facts.outputs.map((o) => o.size)).toEqual([plain.to_bytes().length, withAssets.to_bytes().length]);
    expect(facts.outputs.map((o) => o.valueSize)).toEqual([plain.amount().to_bytes().length, withAssets.amount().to_bytes().length]);
    expect(facts.outputs.map((o) => o.output)).toEqual(parseTransaction(bytes).body.outputs);
    expect(facts.collateralReturn?.size).toBe(plain.to_bytes().length);
    expect(facts.collateralReturn?.output.lovelace).toBe(2_000_000n);
    expect(facts.totalCollateral).toBe(5_000_000n);
    expect(facts.networkId).toBe(0n);
    expect(facts.currentTreasuryValue).toBe(123n);
    expect(facts.treasuryDonation).toBe(456n);
    // CSL writes the auxiliary data without setting body key 7. Transaction.new took aux over, so it is read back from tx.
    expect(facts.auxiliaryData).toEqual({ declaredHash: undefined, computedHash: CSL.hash_auxiliary_data(tx.auxiliary_data()!).to_bytes() });
  });

  it('leaves optional fields empty when the body does not carry them', () => {
    const facts = factsOf(buildTx({ inputs: [input], outputs: out, fee: 200_000n }));
    expect(facts).toMatchObject({
      collateralReturn: undefined,
      totalCollateral: undefined,
      networkId: undefined,
      withdrawals: [],
      treasuryDonation: 0n,
      currentTreasuryValue: undefined,
      certificates: [],
      proposalDeposits: [],
      proposalReturnAccounts: [],
      auxiliaryData: { declaredHash: undefined, computedHash: undefined },
      redeemers: [],
      bootstrapWitnesses: 0,
    });
    expect(facts.mint.size).toBe(0);
  });

  it('counts body, witness set and auxiliary data of an indefinite top-level array plus one byte', () => {
    const body = encode(new Map<bigint, unknown>([[0n, [[input.txId, 0n]]], [1n, [[TEST_ADDRESS, 2_000_000n]]], [2n, 200_000n]]) as never);
    const witnessSet = encode(new Map([[1n, [[1n, []]]]]) as never);
    const aux = encode(new Map([[674n, 'hello']]) as never);
    const bytes = concat(Uint8Array.of(0x9f), body, witnessSet, encode(true), aux, Uint8Array.of(0xff));
    const facts = factsOf(bytes);
    expect(facts.size).toBe(BigInt(1 + body.length + witnessSet.length + aux.length));
    expect(facts.size).toBe(BigInt(bytes.length - 2));
  });

  it('measures an output in the bytes it arrived in, an indefinite array included', () => {
    const indefinite = concat(Uint8Array.of(0x9f), encode(TEST_ADDRESS), encode(2_000_000n), Uint8Array.of(0xff));
    const body = concat(
      Uint8Array.of(0xa3),
      encode(0n), encode([[input.txId, 0n]] as never),
      encode(1n), Uint8Array.of(0x81), indefinite,
      encode(2n), encode(200_000n),
    );
    const bytes = concat(Uint8Array.of(0x84), body, encode(new Map()), encode(true), encode(null));
    const [output] = factsOf(bytes).outputs;
    expect(output?.size).toBe(indefinite.length);
    expect(output?.size).toBe(encode([TEST_ADDRESS, 2_000_000n] as never).length + 1);
    expect(output?.valueSize).toBe(encode(2_000_000n).length);
  });
});

describe('readTransaction: withdrawals, mint, proposals, witnesses', () => {
  it('reads withdrawal amounts with the reward address credential, key and script', () => {
    const keyReward = hexToBytes('e0' + '01'.repeat(28));
    const scriptReward = hexToBytes('f0' + '02'.repeat(28));
    const withdrawals = CSL.Withdrawals.new();
    withdrawals.insert(CSL.RewardAddress.from_address(CSL.Address.from_bytes(keyReward))!, big(5_000_000));
    withdrawals.insert(CSL.RewardAddress.from_address(CSL.Address.from_bytes(scriptReward))!, big(0));
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), big(200_000));
    body.set_withdrawals(withdrawals);
    const facts = factsOf(CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_hex());
    expect(facts.withdrawals).toEqual([
      { rewardAddress: keyReward, credential: keyCred, amount: 5_000_000n },
      { rewardAddress: scriptReward, credential: scriptCred, amount: 0n },
    ]);
  });

  it('reads mint quantities with their sign', () => {
    const mint = CSL.Mint.new();
    const assets = CSL.MintAssets.new();
    assets.insert(CSL.AssetName.new(hexToBytes('41')), CSL.Int.new_i32(10));
    assets.insert(CSL.AssetName.new(hexToBytes('42')), CSL.Int.new_i32(-3));
    mint.insert(CSL.ScriptHash.from_bytes(hexToBytes(POLICY)), assets);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), big(200_000));
    body.set_mint(mint);
    const facts = factsOf(CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_hex());
    expect(facts.mint).toEqual(new Map([[POLICY, new Map([['41', 10n], ['42', -3n]])]]));
  });

  it('reads the deposit and the return account of every proposal procedure in body order', () => {
    const csl = factsOf(cslGovernanceTx({ input: { txId: input.txId, index: 0 }, infoProposal: { rewardAddressHex: 'e0' + '01'.repeat(28) } }));
    expect(csl.proposalDeposits).toEqual([100_000_000_000n]);
    expect(csl.proposalReturnAccounts).toEqual([hexToBytes('e0' + '01'.repeat(28))]);
    const reward = hexToBytes('e0' + '01'.repeat(28));
    const scriptReward = hexToBytes('f1' + '02'.repeat(28));
    const proposals = [[7n, reward, [6n], anchor], [9n, scriptReward, [6n], anchor]];
    const facts = factsOf(withBody([[20n, new Tagged(258n, proposals)]]));
    expect(facts.proposalDeposits).toEqual([7n, 9n]);
    expect(facts.proposalReturnAccounts).toEqual([reward, scriptReward]);
  });

  it('reads redeemers in the map form CSL writes', () => {
    const redeemers = CSL.Redeemers.new();
    const data = CSL.PlutusData.new_integer(CSL.BigInt.from_str('1'));
    redeemers.add(CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(0), data, CSL.ExUnits.new(big(1000), big(2000))));
    redeemers.add(CSL.Redeemer.new(CSL.RedeemerTag.new_mint(), big(1), data, CSL.ExUnits.new(big(3000), big(4000))));
    const witnesses = CSL.TransactionWitnessSet.new();
    witnesses.set_redeemers(redeemers);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const tx = CSL.Transaction.new(CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), big(200_000)), witnesses);
    // 0xa2: CSL writes the Conway map form.
    expect(redeemers.to_hex().startsWith('a2')).toBe(true);
    expect(factsOf(tx.to_hex()).redeemers).toEqual([
      { tag: 0n, index: 0n, mem: 1000n, steps: 2000n },
      { tag: 1n, index: 1n, mem: 3000n, steps: 4000n },
    ]);
  });

  it('reads redeemers in the legacy array form', () => {
    const legacy = [[0n, 0n, 1n, [1000n, 2000n]], [3n, 2n, new Tagged(121n, []), [5n, 6n]]];
    expect(factsOf(withBody([], new Map([[5n, legacy]]))).redeemers).toEqual([
      { tag: 0n, index: 0n, mem: 1000n, steps: 2000n },
      { tag: 3n, index: 2n, mem: 5n, steps: 6n },
    ]);
  });

  it('counts a repeated redeemer key once in the legacy array form, the later ex units win', () => {
    const legacy = [[0n, 0n, 1n, [1000n, 2000n]], [1n, 0n, 1n, [7n, 8n]], [0n, 0n, 1n, [5n, 6n]]];
    expect(factsOf(withBody([], new Map([[5n, legacy]]))).redeemers).toEqual([
      { tag: 0n, index: 0n, mem: 5n, steps: 6n },
      { tag: 1n, index: 0n, mem: 7n, steps: 8n },
    ]);
  });

  it('counts a repeated redeemer key once in the Conway map form, the later ex units win', () => {
    const map = new Map<unknown, unknown>([
      [[0n, 0n], [1n, [1000n, 2000n]]],
      [[1n, 0n], [1n, [7n, 8n]]],
      [[0n, 0n], [1n, [5n, 6n]]],
    ]);
    expect(factsOf(withBody([], new Map([[5n, map]]))).redeemers).toEqual([
      { tag: 0n, index: 0n, mem: 5n, steps: 6n },
      { tag: 1n, index: 0n, mem: 7n, steps: 8n },
    ]);
  });

  it('counts bootstrap witnesses, plain array and tag 258', () => {
    const witness = [new Uint8Array(32), new Uint8Array(64), new Uint8Array(32), hexToBytes('a0')];
    expect(factsOf(withBody([], new Map([[2n, [witness, witness]]]))).bootstrapWitnesses).toBe(2);
    expect(factsOf(withBody([], new Map([[2n, new Tagged(258n, [witness])]]))).bootstrapWitnesses).toBe(1);
  });
});

describe('readTransaction: value size as the ledger serializes it', () => {
  // A distinct 28 byte policy id for every p below 65536.
  const policyId = (p: number) => {
    const id = new Uint8Array(28);
    id[26] = p >> 8;
    id[27] = p & 0xff;
    return id;
  };
  /** The value size of one output of 2 ADA holding policies × names assets, each at quantity 1. One name is the empty name, more are two bytes each. */
  const valueSizeOf = (policies: number, names: number) => {
    const multiasset = new Map<Uint8Array, Map<Uint8Array, bigint>>();
    for (let p = 0; p < policies; p++) {
      const inner = new Map<Uint8Array, bigint>();
      for (let n = 0; n < names; n++) inner.set(names === 1 ? new Uint8Array(0) : Uint8Array.of(n >> 8, n & 0xff), 1n);
      multiasset.set(policyId(p), inner);
    }
    return factsOf(withBody([[1n, [[TEST_ADDRESS, [2_000_000n, multiasset]]]]])).outputs[0]!.valueSize;
  };

  // Every size below is counted by hand from RFC 8949 and Binary/Encoding/Encoder.hs:
  // [coin, multiasset] is a 1 byte array header and 5 bytes for the coin 2000000 (1a 001e8480).
  // A policy id is 2 header bytes plus 28. The empty name is 1 byte (40), a two byte name 3 (42 xx xx),
  // quantity 1 is 1 byte. A map header is 1 byte up to 23 entries. Above 23 the ledger writes an
  // indefinite map, 1 header byte (bf) and 1 break byte (ff), where a definite header would take
  // 2 bytes up to 255 entries and 3 from 256 on.

  it('a coin without assets is a bare uint', () => {
    expect(factsOf(withBody([])).outputs[0]!.valueSize).toBe(5);
  });

  it('23 and 24 policies: a definite outer map, then an indefinite one', () => {
    // 6 + map header + 23 × (30 + 1 inner header + 1 name + 1 quantity)
    expect(valueSizeOf(23, 1)).toBe(6 + 1 + 23 * 33);
    expect(valueSizeOf(24, 1)).toBe(6 + 2 + 24 * 33);
  });

  it('23 and 24 assets under one policy: a definite inner map, then an indefinite one', () => {
    // 6 + 1 outer header + 30 policy + inner map header + n × (3 name + 1 quantity)
    expect(valueSizeOf(1, 23)).toBe(37 + 1 + 23 * 4);
    expect(valueSizeOf(1, 24)).toBe(37 + 2 + 24 * 4);
  });

  it('255 and 256 entries: two bytes for the indefinite header and break, where a definite header would grow to three', () => {
    expect(valueSizeOf(1, 255)).toBe(37 + 2 + 255 * 4);
    expect(valueSizeOf(1, 256)).toBe(37 + 2 + 256 * 4);
    expect(valueSizeOf(255, 1)).toBe(6 + 2 + 255 * 33);
    expect(valueSizeOf(256, 1)).toBe(6 + 2 + 256 * 33);
  });
});

describe('readTransaction: auxiliary data hash', () => {
  const tx = (entries: Array<[bigint, unknown]> = []) => withBody(entries);
  const shelley = encode(new Map([[674n, 'hello']]) as never);
  // Alonzo and later: tag 259 around { 0: metadata }.
  const alonzo = encode(new Tagged(259n, new Map([[0n, new Map([[674n, 'hello']])]])) as never);
  const cslHash = (aux: Uint8Array) => CSL.hash_auxiliary_data(CSL.AuxiliaryData.from_bytes(aux)).to_bytes();

  it('has neither hash when the auxiliary data is null and body key 7 is absent', () => {
    expect(factsOf(tx()).auxiliaryData).toEqual({ declaredHash: undefined, computedHash: undefined });
  });

  it('hashes auxiliary data in the Shelley map form over its original bytes', () => {
    // CSL reads and writes these bytes unchanged, so its hash covers the same bytes.
    expect(CSL.AuxiliaryData.from_bytes(shelley).to_bytes()).toEqual(shelley);
    expect(factsOf(withAux(tx(), shelley)).auxiliaryData).toEqual({ declaredHash: undefined, computedHash: cslHash(shelley) });
  });

  it('hashes auxiliary data in the tagged Alonzo form and reads the hash body key 7 declares', () => {
    expect(CSL.AuxiliaryData.from_bytes(alonzo).to_bytes()).toEqual(alonzo);
    const declared = new Uint8Array(32).fill(7);
    expect(factsOf(withAux(tx([[7n, declared]]), alonzo)).auxiliaryData).toEqual({ declaredHash: declared, computedHash: cslHash(alonzo) });
  });

  it('reads body key 7 without auxiliary data', () => {
    const declared = cslHash(shelley);
    expect(factsOf(tx([[7n, declared]])).auxiliaryData).toEqual({ declaredHash: declared, computedHash: undefined });
  });
});

describe('readTransaction: certificates', () => {
  const stake = (c: typeof CSL) => c.Credential.from_keyhash(c.Ed25519KeyHash.from_bytes(hash28(1)));
  const scriptStake = (c: typeof CSL) => c.Credential.from_scripthash(c.ScriptHash.from_bytes(hash28(2)));
  const pool = (c: typeof CSL) => c.Ed25519KeyHash.from_bytes(hash28(3));
  const drep = (c: typeof CSL) => c.DRep.new_key_hash(c.Ed25519KeyHash.from_bytes(hash28(4)));
  const cslAnchor = (c: typeof CSL) => c.Anchor.new(c.URL.new('https://example.com/a.json'), c.AnchorDataHash.from_bytes(new Uint8Array(32)));
  const poolParams = (c: typeof CSL) => {
    const owners = c.Ed25519KeyHashes.new();
    owners.add(c.Ed25519KeyHash.from_bytes(hash28(5)));
    const reward = c.RewardAddress.from_address(c.Address.from_bytes(hexToBytes('e0' + '05'.repeat(28))))!;
    return c.PoolParams.new(pool(c), c.VRFKeyHash.from_bytes(new Uint8Array(32).fill(6)), big(0), big(340_000_000), c.UnitInterval.new(big(1), big(100)), reward, owners, c.Relays.new());
  };

  const cases: Array<[string, CslCert, CertFact]> = [
    ['0 account_registration', (c) => c.Certificate.new_stake_registration(c.StakeRegistration.new(stake(c))), { kind: 'accountRegistration', cert: 0n, credential: keyCred, deposit: undefined }],
    ['1 account_unregistration', (c) => c.Certificate.new_stake_deregistration(c.StakeDeregistration.new(scriptStake(c))), { kind: 'accountUnregistration', cert: 1n, credential: scriptCred, refund: undefined }],
    ['2 delegation_to_stake_pool', (c) => c.Certificate.new_stake_delegation(c.StakeDelegation.new(stake(c), pool(c))), { kind: 'delegation', cert: 2n, credential: keyCred }],
    ['3 pool_registration', (c) => c.Certificate.new_pool_registration(c.PoolRegistration.new(poolParams(c))), { kind: 'poolRegistration', cert: 3n, poolId: hash28(3) }],
    ['4 pool_retirement', (c) => c.Certificate.new_pool_retirement(c.PoolRetirement.new(pool(c), 300)), { kind: 'poolRetirement', cert: 4n, poolId: hash28(3) }],
    ['7 account_registration_deposit', (c) => c.Certificate.new_stake_registration(c.StakeRegistration.new_with_explicit_deposit(stake(c), big(2_000_000))), { kind: 'accountRegistration', cert: 7n, credential: keyCred, deposit: 2_000_000n }],
    ['8 account_unregistration_deposit', (c) => c.Certificate.new_stake_deregistration(c.StakeDeregistration.new_with_explicit_refund(stake(c), big(2_000_000))), { kind: 'accountUnregistration', cert: 8n, credential: keyCred, refund: 2_000_000n }],
    ['9 delegation_to_drep', (c) => c.Certificate.new_vote_delegation(c.VoteDelegation.new(stake(c), c.DRep.new_always_abstain())), { kind: 'delegation', cert: 9n, credential: keyCred }],
    ['10 delegation_to_stake_pool_and_drep', (c) => c.Certificate.new_stake_and_vote_delegation(c.StakeAndVoteDelegation.new(stake(c), pool(c), drep(c))), { kind: 'delegation', cert: 10n, credential: keyCred }],
    ['11 account_registration_delegation_to_stake_pool', (c) => c.Certificate.new_stake_registration_and_delegation(c.StakeRegistrationAndDelegation.new(stake(c), pool(c), big(3))), { kind: 'accountRegistration', cert: 11n, credential: keyCred, deposit: 3n }],
    ['12 account_registration_delegation_to_drep', (c) => c.Certificate.new_vote_registration_and_delegation(c.VoteRegistrationAndDelegation.new(stake(c), drep(c), big(4))), { kind: 'accountRegistration', cert: 12n, credential: keyCred, deposit: 4n }],
    ['13 account_registration_delegation_to_stake_pool_and_drep', (c) => c.Certificate.new_stake_vote_registration_and_delegation(c.StakeVoteRegistrationAndDelegation.new(stake(c), pool(c), drep(c), big(5))), { kind: 'accountRegistration', cert: 13n, credential: keyCred, deposit: 5n }],
    ['14 committee_authorization', (c) => c.Certificate.new_committee_hot_auth(c.CommitteeHotAuth.new(stake(c), scriptStake(c))), { kind: 'committee', cert: 14n }],
    ['15 committee_resignation', (c) => c.Certificate.new_committee_cold_resign(c.CommitteeColdResign.new_with_anchor(stake(c), cslAnchor(c))), { kind: 'committee', cert: 15n }],
    ['16 drep_registration', (c) => c.Certificate.new_drep_registration(c.DRepRegistration.new_with_anchor(scriptStake(c), big(500_000_000), cslAnchor(c))), { kind: 'drepRegistration', cert: 16n, credential: scriptCred, deposit: 500_000_000n }],
    ['17 drep_unregistration', (c) => c.Certificate.new_drep_deregistration(c.DRepDeregistration.new(stake(c), big(500_000_000))), { kind: 'drepUnregistration', cert: 17n, credential: keyCred, refund: 500_000_000n }],
    ['18 drep_update', (c) => c.Certificate.new_drep_update(c.DRepUpdate.new(stake(c))), { kind: 'drepUpdate', cert: 18n, credential: keyCred }],
  ];

  it.each(cases)('reads certificate %s as CSL writes it', (_name, make, expected) => {
    const facts = factsOf(cslGovernanceTx({ input: { txId: input.txId, index: 0 }, certificates: [make] }));
    expect(facts.certificates).toEqual([expected]);
  });

  it.each([5n, 6n])('keeps the pre-Conway certificate %s as deprecated', (index) => {
    expect(factsOf(withBody([[4n, [[index, new Map()]]]])).certificates).toEqual([{ kind: 'deprecated', cert: index }]);
  });

  it('keeps body order across a tag 258 set', () => {
    const certs = [[7n, [0n, hash28(1)], 2_000_000n], [17n, [1n, hash28(2)], 9n]];
    expect(factsOf(withBody([[4n, new Tagged(258n, certs)]])).certificates.map((c) => c.cert)).toEqual([7n, 17n]);
  });
});

describe('readTransaction: malformed fields', () => {
  it('refuses a body without a fee', () => {
    const body = new Map<bigint, unknown>([[0n, [[input.txId, 0n]]], [1n, []]]);
    const bytes = encode([body, new Map(), true, null] as never);
    expect(() => factsOf(bytes)).toThrow('transaction body has no fee');
  });

  it.each<[string, Array<[bigint, unknown]>, string]>([
    ['a fee that is not a coin', [[2n, hexToBytes('01')]], 'malformed fee'],
    ['a network id other than 0 or 1', [[15n, 2n]], 'malformed network id'],
    ['a donation of 0', [[22n, 0n]], 'malformed treasury donation'],
    ['a negative current treasury value', [[21n, -1n]], 'malformed current treasury value'],
    ['a withdrawal from a base address', [[5n, new Map([[hexToBytes('00' + '01'.repeat(28)), 1n]])]], 'malformed withdrawal reward address'],
    ['a withdrawal with a negative amount', [[5n, new Map([[hexToBytes('e0' + '01'.repeat(28)), -1n]])]], 'malformed withdrawal amount'],
    ['a certificate with a field too many', [[4n, [[0n, [0n, hash28(1)], 1n]]]], 'malformed certificate 0 (account_registration)'],
    ['a certificate with a 27 byte credential', [[4n, [[7n, [0n, new Uint8Array(27)], 1n]]]], 'malformed credential in certificate 7 (account_registration_deposit)'],
    ['a certificate with credential type 2', [[4n, [[9n, [2n, hash28(1)], [2n]]]]], 'malformed credential in certificate 9 (delegation_to_drep)'],
    ['a registration with a negative deposit', [[4n, [[7n, [0n, hash28(1)], -1n]]]], 'malformed deposit in certificate 7 (account_registration_deposit)'],
    ['a DRep delegation to DRep type 4', [[4n, [[9n, [0n, hash28(1)], [4n]]]]], 'malformed drep in certificate 9 (delegation_to_drep)'],
    ['a DRep registration with a malformed anchor', [[4n, [[16n, [0n, hash28(1)], 5n, ['url']]]]], 'malformed anchor in certificate 16 (drep_registration)'],
    ['an unknown certificate', [[4n, [[19n, [0n, hash28(1)]]]]], 'unknown certificate 19'],
    ['a proposal whose deposit is not a coin', [[20n, [['x', hexToBytes('e0' + '01'.repeat(28)), [6n], anchor]]]], 'malformed proposal deposit'],
    ['a proposal returning to an enterprise address', [[20n, [[7n, hexToBytes('60' + '01'.repeat(28)), [6n], anchor]]]], 'malformed proposal reward account'],
    ['a proposal returning to 28 bytes', [[20n, [[7n, hexToBytes('e0' + '01'.repeat(27)), [6n], anchor]]]], 'malformed proposal reward account'],
    ['an auxiliary data hash of 31 bytes', [[7n, new Uint8Array(31)]], 'malformed auxiliary data hash'],
  ])('refuses %s', (_name, entries, message) => {
    expect(() => factsOf(withBody(entries))).toThrow(message);
  });

  it.each<[string, unknown, string]>([
    ['a redeemer tag of 6', [[6n, 0n, 1n, [1n, 1n]]], 'malformed redeemer tag'],
    ['a redeemer index above 2^32 - 1', [[0n, 0x100000000n, 1n, [1n, 1n]]], 'malformed redeemer index'],
    ['legacy redeemers with three fields', [[0n, 0n, [1n, 1n]]], 'malformed redeemer'],
    ['ex units with a negative step count', new Map([[[0n, 0n], [1n, [1n, -1n]]]]), 'malformed redeemer ex units'],
    ['a map key that is not [tag, index]', new Map([[0n, [1n, [1n, 1n]]]]), 'malformed redeemer key'],
    ['redeemers that are neither array nor map', 5n, 'malformed redeemers'],
  ])('refuses %s', (_name, redeemers, message) => {
    expect(() => factsOf(withBody([], new Map([[5n, redeemers]])))).toThrow(message);
  });

  it('names a malformed certificate the way requirements() does, the text a dApp sees on either path', () => {
    // [7, credential] lacks the deposit field of account_registration_deposit.
    const bytes = hexToBytes(withBody([[4n, [[7n, [0n, hash28(1)]]]]]));
    const parsed = parseTransaction(bytes);
    expect(() => readTransaction(bytes, parsed)).toThrow(/^malformed certificate 7 \(account_registration_deposit\)$/);
    expect(() => requirements(parsed.body, [])).toThrow(expect.objectContaining({ info: 'malformed certificate 7 (account_registration_deposit)' }));
  });
});

describe('credentialKey', () => {
  it('prefixes the hash with the credential kind', () => {
    expect(credentialKey(keyCred)).toBe(`key:${bytesToHex(hash28(1))}`);
    expect(credentialKey(scriptCred)).toBe(`script:${bytesToHex(hash28(2))}`);
  });
});

describe('headerNetwork', () => {
  it('reads bit 0 of the header, the way a node reads the network of an address', () => {
    expect(headerNetwork(hexToBytes('e0' + '00'.repeat(28)))).toBe(0);
    expect(headerNetwork(hexToBytes('e1' + '00'.repeat(28)))).toBe(1);
    expect(headerNetwork(hexToBytes('e2' + '00'.repeat(28)))).toBe(0);
    expect(headerNetwork(hexToBytes('e3' + '00'.repeat(28)))).toBe(1);
    expect(headerNetwork(hexToBytes('71' + '00'.repeat(28)))).toBe(1);
    expect(headerNetwork(TEST_ADDRESS)).toBe(TEST_ADDRESS[0]! & 1);
  });

  it('throws on an empty address', () => {
    expect(() => headerNetwork(new Uint8Array())).toThrow('empty address');
  });
});
