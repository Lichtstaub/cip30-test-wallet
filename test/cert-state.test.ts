import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { rewardAddressBytes, toBech32 } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { MemoryLedger } from '../src/core/ledger.js';
import { applyCertificates, certificateFailures, depositsAndRefunds, initialCertState, type CertState } from '../src/host/checks/cert-state.js';
import { mismatch, PATH, renderFailure, type Failure } from '../src/host/checks/failure.js';
import { credentialKey, readTransaction, type CertFact, type Credential, type TxFacts } from '../src/host/checks/read-tx.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { buildTx, TEST_ADDRESS } from './helpers/build-tx.js';
import { cslGovernanceTx } from './helpers/csl-governance.js';
import { hash28, syntheticInput } from './helpers/synthetic.js';

const P = DEFAULT_PROTOCOL_PARAMS[0];
const K = P.keyDeposit;
const D = P.drepDeposit;
const OWN: Credential = { isScript: false, hash: hash28(1) };
const OTHER: Credential = { isScript: false, hash: hash28(2) };
const SCRIPT: Credential = { isScript: true, hash: hash28(3) };
const POOL = hash28(4);
const POOL_HEX = bytesToHex(POOL);
/** The testnet reward account of OWN, where a proposal returns its deposit unless a test says otherwise. */
const OWN_ACCOUNT = rewardAddressBytes(0, OWN.hash);

const facts = (certificates: CertFact[], proposalDeposits: bigint[] = [], proposalReturnAccounts: Uint8Array[] = proposalDeposits.map(() => OWN_ACCOUNT)): TxFacts => ({
  size: 0n,
  fee: 0n,
  outputs: [],
  collateralReturn: undefined,
  totalCollateral: undefined,
  networkId: undefined,
  withdrawals: [],
  mint: new Map(),
  treasuryDonation: 0n,
  currentTreasuryValue: undefined,
  certificates,
  proposalDeposits,
  proposalReturnAccounts,
  auxiliaryData: { declaredHash: undefined, computedHash: undefined },
  redeemers: [],
  bootstrapWitnesses: 0,
});
const state = (opts: { accounts?: Array<[Credential, bigint]>; dreps?: Array<[Credential, bigint]>; pools?: string[] } = {}): CertState => ({
  accounts: new Map((opts.accounts ?? []).map(([c, d]) => [credentialKey(c), d])),
  dreps: new Map((opts.dreps ?? []).map(([c, d]) => [credentialKey(c), d])),
  pools: new Set(opts.pools ?? []),
});

const reg = (cert: 0n | 7n | 11n | 12n | 13n, credential: Credential, deposit?: bigint): CertFact => ({ kind: 'accountRegistration', cert, credential, deposit: cert === 0n ? undefined : (deposit ?? K) });
const unreg = (cert: 1n | 8n, credential: Credential, refund?: bigint): CertFact => ({ kind: 'accountUnregistration', cert, credential, refund: cert === 1n ? undefined : (refund ?? K) });
const deleg = (cert: 2n | 9n | 10n, credential: Credential): CertFact => ({ kind: 'delegation', cert, credential });
const poolReg: CertFact = { kind: 'poolRegistration', cert: 3n, poolId: POOL };
const poolRetire: CertFact = { kind: 'poolRetirement', cert: 4n, poolId: POOL };
const drepReg = (credential: Credential, deposit = D): CertFact => ({ kind: 'drepRegistration', cert: 16n, credential, deposit });
const drepUnreg = (credential: Credential, refund = D): CertFact => ({ kind: 'drepUnregistration', cert: 17n, credential, refund });
const drepUpdate = (credential: Credential): CertFact => ({ kind: 'drepUpdate', cert: 18n, credential });

const keyObj = (c: Credential) =>
  c.isScript ? `ScriptHashObj (ScriptHash "${bytesToHex(c.hash)}")` : `KeyHashObj (KeyHash {unKeyHash = "${bytesToHex(c.hash)}"})`;
const coinMismatch = (supplied: bigint, expected: bigint) => mismatch('RelEQ', `Coin ${supplied}`, `Coin ${expected}`);
const failure = (path: readonly string[], rule: string, detail: string): string => renderFailure({ path, rule, detail });

describe('initialCertState', () => {
  it('seeds the own stake key and DRep key with the parameter deposits when registered', () => {
    const s = initialCertState({ stakeKeyHash: OWN.hash, stakeRegistered: true, drepKeyHash: OTHER.hash, drepRegistered: true, params: P });
    expect(s).toEqual(state({ accounts: [[OWN, K]], dreps: [[OTHER, D]] }));
  });

  it('starts empty when neither is registered', () => {
    expect(initialCertState({ stakeKeyHash: OWN.hash, stakeRegistered: false, drepKeyHash: OTHER.hash, drepRegistered: false, params: P })).toEqual(state());
  });
});

describe('depositsAndRefunds', () => {
  it.each<[string, CertFact[], bigint[], CertState, { deposits: bigint; refunds: bigint }]>([
    ['certificate 0 pays keyDeposit', [reg(0n, OWN)], [], state(), { deposits: K, refunds: 0n }],
    ['certificate 7 pays keyDeposit whatever its field says', [reg(7n, OWN, 5n)], [], state(), { deposits: K, refunds: 0n }],
    ['certificates 11, 12 and 13 pay keyDeposit each', [reg(11n, OWN), reg(12n, OTHER), reg(13n, SCRIPT)], [], state(), { deposits: 3n * K, refunds: 0n }],
    ['a DRep registration pays drepDeposit whatever its field says', [drepReg(OWN, 1n)], [], state(), { deposits: D, refunds: 0n }],
    ['a new pool pays poolDeposit', [poolReg], [], state(), { deposits: P.poolDeposit, refunds: 0n }],
    ['a pool registered twice in one transaction pays once', [poolReg, poolReg], [], state(), { deposits: P.poolDeposit, refunds: 0n }],
    ['a pool already in the state re-registers for free', [poolReg], [], state({ pools: [POOL_HEX] }), { deposits: 0n, refunds: 0n }],
    ['every proposal pays govActionDeposit whatever its field says', [], [1n, 2n], state(), { deposits: 2n * P.govActionDeposit, refunds: 0n }],
    ['an unregistration refunds the stored deposit', [unreg(1n, OWN)], [], state({ accounts: [[OWN, 3_000_000n]] }), { deposits: 0n, refunds: 3_000_000n }],
    ['an unregistration after a registration in the same transaction refunds keyDeposit', [reg(7n, OTHER), unreg(8n, OTHER)], [], state(), { deposits: K, refunds: K }],
    ['an unregistration of an unregistered credential refunds 0', [unreg(8n, OTHER, K)], [], state(), { deposits: 0n, refunds: 0n }],
    ['a DRep unregistration refunds its own field', [drepUnreg(OWN, 7n)], [], state(), { deposits: 0n, refunds: 7n }],
    [
      'refunds read the state before the transaction',
      [unreg(1n, OWN), reg(0n, OWN), unreg(1n, OWN)],
      [],
      state({ accounts: [[OWN, 3_000_000n]] }),
      { deposits: K, refunds: 3_000_000n + K },
    ],
    ['delegation, DRep update, retirement, committee and deprecated certificates cost nothing', [deleg(2n, OWN), drepUpdate(OWN), poolRetire, { kind: 'committee', cert: 14n }, { kind: 'deprecated', cert: 6n }], [], state(), { deposits: 0n, refunds: 0n }],
  ])('%s', (_name, certificates, proposals, before, expected) => {
    expect(depositsAndRefunds(facts(certificates, proposals), before, P)).toEqual(expected);
  });
});

describe('certificateFailures', () => {
  const REGISTERED = state({ accounts: [[OWN, K]] });
  it.each<[string, CertFact[], CertState, string[]]>([
    ['a registration of a registered credential', [reg(0n, OWN)], REGISTERED, [failure(PATH.DELEG, 'StakeKeyRegisteredDELEG', keyObj(OWN))]],
    ['a registration twice in one transaction', [reg(0n, OTHER), reg(7n, OTHER)], state(), [failure(PATH.DELEG, 'StakeKeyRegisteredDELEG', keyObj(OTHER))]],
    ['a registration deposit field other than keyDeposit', [reg(7n, OTHER, 1n)], state(), [failure(PATH.DELEG, 'DepositIncorrectDELEG', coinMismatch(1n, K))]],
    [
      'a wrong deposit field on a registered credential, deposit first',
      [reg(11n, OWN, 1n)],
      REGISTERED,
      [failure(PATH.DELEG, 'DepositIncorrectDELEG', coinMismatch(1n, K)), failure(PATH.DELEG, 'StakeKeyRegisteredDELEG', keyObj(OWN))],
    ],
    ['a wrong deposit field in certificate 12', [reg(12n, OTHER, K + 1n)], state(), [failure(PATH.DELEG, 'DepositIncorrectDELEG', coinMismatch(K + 1n, K))]],
    ['a wrong deposit field in certificate 13', [reg(13n, OTHER, 0n)], state(), [failure(PATH.DELEG, 'DepositIncorrectDELEG', coinMismatch(0n, K))]],
    ['an unregistration of an unregistered credential', [unreg(1n, OTHER)], state(), [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OTHER))]],
    ['a refund field on an unregistered credential reports only the registration', [unreg(8n, OTHER, 1n)], state(), [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OTHER))]],
    ['a refund field other than the stored deposit', [unreg(8n, OWN, 1n)], REGISTERED, [failure(PATH.DELEG, 'RefundIncorrectDELEG', coinMismatch(1n, K))]],
    ['a stake pool delegation of an unregistered credential', [deleg(2n, OTHER)], state(), [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OTHER))]],
    ['a DRep delegation of an unregistered script credential', [deleg(9n, SCRIPT)], state(), [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(SCRIPT))]],
    ['a pool and DRep delegation of an unregistered credential', [deleg(10n, OTHER)], state(), [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OTHER))]],
    ['a delegation after an unregistration in the same transaction', [unreg(1n, OWN), deleg(2n, OWN)], REGISTERED, [failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OWN))]],
    ['a retirement of an unknown pool', [poolRetire], state(), [failure(PATH.POOL, 'StakePoolNotRegisteredOnKeyPOOL', `KeyHash {unKeyHash = "${POOL_HEX}"}`)]],
    ['a DRep registration of a registered DRep', [drepReg(OWN)], state({ dreps: [[OWN, D]] }), [failure(PATH.GOVCERT, 'ConwayDRepAlreadyRegistered', keyObj(OWN))]],
    ['a DRep deposit field other than drepDeposit', [drepReg(OWN, 1n)], state(), [failure(PATH.GOVCERT, 'ConwayDRepIncorrectDeposit', coinMismatch(1n, D))]],
    [
      'a registered DRep with a wrong deposit field, registration first',
      [drepReg(SCRIPT, 1n)],
      state({ dreps: [[SCRIPT, D]] }),
      [failure(PATH.GOVCERT, 'ConwayDRepAlreadyRegistered', keyObj(SCRIPT)), failure(PATH.GOVCERT, 'ConwayDRepIncorrectDeposit', coinMismatch(1n, D))],
    ],
    ['a DRep unregistration of an unknown DRep', [drepUnreg(OTHER)], state(), [failure(PATH.GOVCERT, 'ConwayDRepNotRegistered', keyObj(OTHER))]],
    ['a DRep refund other than the stored deposit', [drepUnreg(OWN, D - 1n)], state({ dreps: [[OWN, D]] }), [failure(PATH.GOVCERT, 'ConwayDRepIncorrectRefund', coinMismatch(D - 1n, D))]],
    ['a DRep update of an unknown DRep', [drepUpdate(OTHER)], state(), [failure(PATH.GOVCERT, 'ConwayDRepNotRegistered', keyObj(OTHER))]],
  ])('reports %s', (_name, certificates, before, expected) => {
    expect(certificateFailures(facts(certificates), before, P, 0).map(renderFailure)).toEqual(expected);
  });

  it.each<[string, CertFact[], CertState]>([
    ['certificate 0 on an unregistered credential, no deposit field to check', [reg(0n, OTHER)], state()],
    ['registrations 7, 11, 12 and 13 with keyDeposit', [reg(7n, OTHER), reg(11n, SCRIPT), reg(12n, { isScript: false, hash: hash28(8) }), reg(13n, { isScript: false, hash: hash28(9) })], state()],
    ['an unregistration with the stored deposit as refund', [unreg(8n, OWN, K)], state({ accounts: [[OWN, K]] })],
    ['register, delegate and unregister in one transaction', [reg(7n, OTHER), deleg(9n, OTHER), deleg(10n, OTHER), unreg(8n, OTHER, K)], state()],
    ['a delegation of a registered credential', [deleg(2n, OWN)], state({ accounts: [[OWN, K]] })],
    ['a new pool, its re-registration and its retirement', [poolReg, poolReg, poolRetire], state()],
    ['a re-registration and retirement of a pool in the state', [poolReg, poolRetire], state({ pools: [POOL_HEX] })],
    ['register, update and unregister a DRep in one transaction', [drepReg(OWN), drepUpdate(OWN), drepUnreg(OWN, D)], state()],
    ['committee and deprecated certificates', [{ kind: 'committee', cert: 14n }, { kind: 'committee', cert: 15n }, { kind: 'deprecated', cert: 5n }], state()],
  ])('accepts %s', (_name, certificates, before) => {
    expect(certificateFailures(facts(certificates), before, P, 0)).toEqual([]);
  });

  it('checks certificates a builder wrote', () => {
    const stake = (c: typeof CSL) => c.Credential.from_keyhash(c.Ed25519KeyHash.from_bytes(OTHER.hash));
    const tx = cslGovernanceTx({
      input: { txId: syntheticInput('cert-state', 0n).txId, index: 0 },
      certificates: [
        (c) => c.Certificate.new_stake_registration(c.StakeRegistration.new_with_explicit_deposit(stake(c), c.BigNum.from_str(K.toString()))),
        (c) => c.Certificate.new_vote_delegation(c.VoteDelegation.new(stake(c), c.DRep.new_always_abstain())),
        (c) => c.Certificate.new_drep_registration(c.DRepRegistration.new(stake(c), c.BigNum.from_str('1'))),
      ],
    });
    const bytes = hexToBytes(tx);
    const read = readTransaction(bytes, parseTransaction(bytes));
    expect(depositsAndRefunds(read, state(), P)).toEqual({ deposits: K + D, refunds: 0n });
    expect(certificateFailures(read, state(), P, 0).map(renderFailure)).toEqual([failure(PATH.GOVCERT, 'ConwayDRepIncorrectDeposit', coinMismatch(1n, D))]);
  });
});

describe('certificateFailures: proposals after the certificates', () => {
  const G = P.govActionDeposit;
  const OTHER_ACCOUNT = rewardAddressBytes(0, OTHER.hash);
  const REGISTERED = state({ accounts: [[OWN, K]] });
  const gov = (rule: string, detail: string) => failure(PATH.GOV, rule, detail);
  const noAccount = (account: Uint8Array) => gov('ProposalReturnAccountDoesNotExist', toBech32(account));
  const badDeposit = (supplied: bigint) => gov('ProposalDepositIncorrect', coinMismatch(supplied, G));
  const wrongNetwork = (account: Uint8Array, expected = 'Testnet') => gov('ProposalProcedureNetworkIdMismatch', `{account: ${toBech32(account)}, expected: ${expected}}`);
  /** Proposals as [deposit, return account]. */
  const run = (certificates: CertFact[], proposals: Array<[bigint, Uint8Array]>, before: CertState, networkId: 0 | 1 = 0) =>
    certificateFailures(facts(certificates, proposals.map(([deposit]) => deposit), proposals.map(([, account]) => account)), before, P, networkId).map(renderFailure);

  it('accepts a proposal with govActionDeposit returning to a registered account of the network', () => {
    expect(run([], [[G, OWN_ACCOUNT]], REGISTERED)).toEqual([]);
  });

  it('checks one proposal after the other, each in the order return account, deposit, network', () => {
    const mainnetOther = rewardAddressBytes(1, OTHER.hash);
    expect(run([unreg(1n, OTHER)], [[5n, mainnetOther], [6n, OTHER_ACCOUNT], [G, OWN_ACCOUNT]], REGISTERED)).toEqual([
      failure(PATH.DELEG, 'StakeKeyNotRegisteredDELEG', keyObj(OTHER)),
      noAccount(mainnetOther),
      badDeposit(5n),
      wrongNetwork(mainnetOther),
      noAccount(OTHER_ACCOUNT),
      badDeposit(6n),
    ]);
  });

  it('ProposalReturnAccountDoesNotExist: the own account registered earlier in the same transaction passes, GOV sees the state after CERTS', () => {
    expect(run([reg(7n, OWN)], [[G, OWN_ACCOUNT]], state())).toEqual([]);
    expect(run([], [[G, OWN_ACCOUNT]], state())).toEqual([noAccount(OWN_ACCOUNT)]);
  });

  it('ProposalReturnAccountDoesNotExist: an account unregistered earlier in the same transaction', () => {
    expect(run([unreg(1n, OWN)], [[G, OWN_ACCOUNT]], REGISTERED)).toEqual([noAccount(OWN_ACCOUNT)]);
  });

  it('ProposalReturnAccountDoesNotExist: a foreign account starts unregistered and is refused', () => {
    expect(run([], [[G, OTHER_ACCOUNT]], REGISTERED)).toEqual([noAccount(OTHER_ACCOUNT)]);
  });

  it('ProposalReturnAccountDoesNotExist: looks up kind and hash of the credential, the network tag has its own check', () => {
    const scriptAccount = hexToBytes('f0' + bytesToHex(SCRIPT.hash));
    const keyWithScriptHash = hexToBytes('e0' + bytesToHex(SCRIPT.hash));
    const scriptRegistered = state({ accounts: [[SCRIPT, K]] });
    expect(run([], [[G, scriptAccount]], scriptRegistered)).toEqual([]);
    expect(run([], [[G, keyWithScriptHash]], scriptRegistered)).toEqual([noAccount(keyWithScriptHash)]);
    // A registered credential under the other network tag exists, only the network check fails.
    const mainnetOwn = rewardAddressBytes(1, OWN.hash);
    expect(run([], [[G, mainnetOwn]], REGISTERED)).toEqual([wrongNetwork(mainnetOwn)]);
  });

  it('ProposalProcedureNetworkIdMismatch: a testnet account on mainnet', () => {
    expect(run([], [[G, OWN_ACCOUNT]], REGISTERED, 1)).toEqual([wrongNetwork(OWN_ACCOUNT, 'Mainnet')]);
    expect(run([], [[G, rewardAddressBytes(1, OWN.hash)]], REGISTERED, 1)).toEqual([]);
  });

  it('checks a proposal a builder wrote', () => {
    const tx = cslGovernanceTx({ input: { txId: syntheticInput('cert-state-proposal', 0n).txId, index: 0 }, infoProposal: { rewardAddressHex: bytesToHex(OTHER_ACCOUNT) } });
    const bytes = hexToBytes(tx);
    const read = readTransaction(bytes, parseTransaction(bytes));
    // The CSL helper pays the mainnet deposit of 100000 ADA, preprod asks for 1000.
    expect(certificateFailures(read, state(), P, 0).map(renderFailure)).toEqual([noAccount(OTHER_ACCOUNT), badDeposit(100_000_000_000n)]);
    expect(certificateFailures(read, state({ accounts: [[OTHER, K]] }), P, 0).map(renderFailure)).toEqual([badDeposit(100_000_000_000n)]);
    expect(certificateFailures(read, state({ accounts: [[OTHER, K]] }), DEFAULT_PROTOCOL_PARAMS[1], 0)).toEqual<Failure[]>([]);
  });
});

describe('applyCertificates', () => {
  it.each<[string, CertFact[], CertState, CertState]>([
    ['a registration stores keyDeposit whatever its field says', [reg(7n, OTHER, 5n)], state(), state({ accounts: [[OTHER, K]] })],
    ['an unregistration removes the account', [unreg(8n, OWN)], state({ accounts: [[OWN, K]] }), state()],
    ['register and unregister in one transaction leaves nothing', [reg(0n, OTHER), unreg(1n, OTHER)], state(), state()],
    ['a DRep registration stores drepDeposit whatever its field says', [drepReg(SCRIPT, 1n)], state(), state({ dreps: [[SCRIPT, D]] })],
    ['a DRep unregistration removes the DRep', [drepUnreg(OWN)], state({ dreps: [[OWN, D]] }), state()],
    ['a pool registration adds the pool', [poolReg], state(), state({ pools: [POOL_HEX] })],
    ['a retirement leaves the pool until an epoch boundary', [poolRetire], state({ pools: [POOL_HEX] }), state({ pools: [POOL_HEX] })],
    ['delegations, updates, committee and deprecated certificates change nothing', [deleg(2n, OWN), drepUpdate(OWN), { kind: 'committee', cert: 15n }, { kind: 'deprecated', cert: 5n }], state({ accounts: [[OWN, K]], dreps: [[OWN, D]] }), state({ accounts: [[OWN, K]], dreps: [[OWN, D]] })],
  ])('%s', (_name, certificates, before, after) => {
    expect(applyCertificates(before, facts(certificates), P)).toEqual(after);
  });

  it('leaves the state it was given unchanged', () => {
    const before = state({ accounts: [[OWN, K]], dreps: [[OWN, D]] });
    const snapshot = state({ accounts: [[OWN, K]], dreps: [[OWN, D]] });
    const after = applyCertificates(before, facts([unreg(1n, OWN), drepUnreg(OWN), reg(7n, OTHER), poolReg]), P);
    expect(before).toEqual(snapshot);
    expect(after.accounts).not.toBe(before.accounts);
    expect(after.dreps).not.toBe(before.dreps);
    expect(after.pools).not.toBe(before.pools);
  });
});

describe('applyCertificates and MemoryLedger agree on the own stake registration', () => {
  const own = [0n, OWN.hash];
  // Every certificate that registers or unregisters a stake credential, in its Conway CDDL shape.
  const raw = (cert: bigint, credential: unknown[] = own): unknown[] => {
    const drep = [2n];
    switch (cert) {
      case 0n:
      case 1n:
        return [cert, credential];
      case 7n:
      case 8n:
        return [cert, credential, K];
      case 9n:
        return [cert, credential, drep];
      case 11n:
        return [cert, credential, POOL, K];
      case 12n:
        return [cert, credential, drep, K];
      default:
        return [13n, credential, POOL, drep, K];
    }
  };
  const wallet = { paymentKeyHash: hash28(7), stakeKeyHash: OWN.hash, networkId: 0 as const };
  // A fresh input per transaction, so no two transactions share an id.
  let submitted = 0;

  const check = async (transactions: unknown[][][], registered: boolean) => {
    const ledger = new MemoryLedger({ owned: [], wallet, stakeRegistered: registered });
    let certState = initialCertState({ stakeKeyHash: OWN.hash, stakeRegistered: registered, drepKeyHash: hash28(8), drepRegistered: false, params: P });
    for (const certificates of transactions) {
      const bytes = hexToBytes(
        buildTx({ inputs: [syntheticInput('agree', BigInt(submitted++))], outputs: [{ address: TEST_ADDRESS, lovelace: 1n }], fee: 1n, extraBodyEntries: new Map([[4n, certificates]]) }),
      );
      certState = applyCertificates(certState, readTransaction(bytes, parseTransaction(bytes)), P);
      await ledger.submit(bytes);
      expect(certState.accounts.has(credentialKey(OWN))).toBe(await ledger.getStakeRegistered());
    }
    return ledger.getStakeRegistered();
  };

  it.each<[string, bigint[], boolean, boolean]>([
    ['0 registers', [0n], false, true],
    ['7 registers', [7n], false, true],
    ['11 registers', [11n], false, true],
    ['12 registers', [12n], false, true],
    ['13 registers', [13n], false, true],
    ['1 unregisters', [1n], true, false],
    ['8 unregisters', [8n], true, false],
    ['7 then 8 in one transaction', [7n, 8n], false, false],
    ['8 then 7 in one transaction', [8n, 7n], true, true],
    ['0, 1, 0 in one transaction', [0n, 1n, 0n], false, true],
    ['a delegation changes nothing', [9n], true, true],
  ])('%s', async (_name, certs, before, after) => {
    expect(await check([certs.map((c) => raw(c))], before)).toBe(after);
  });

  it('ignores another credential and a script credential with the own hash', async () => {
    expect(await check([[raw(7n, [0n, OTHER.hash])], [raw(7n, [1n, OWN.hash])]], false)).toBe(false);
    expect(await check([[raw(8n, [0n, OTHER.hash])], [raw(8n, [1n, OWN.hash])]], true)).toBe(true);
  });

  it('agrees after every transaction of a sequence', async () => {
    expect(await check([[raw(7n)], [raw(9n)], [raw(8n)], [raw(11n)], [raw(1n), raw(13n)]], false)).toBe(true);
  });
});
