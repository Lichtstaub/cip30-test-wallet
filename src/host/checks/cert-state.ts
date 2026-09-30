import { toBech32 } from '../../core/addresses.js';
import { bytesToHex } from '../../core/bytes.js';
import type { ProtocolParams } from '../protocol-params.js';
import { mismatch, PATH, type Failure } from './failure.js';
import { credentialKey, headerNetwork, type Credential, type TxFacts } from './read-tx.js';

// The part of the ledger's CertState the offline checks follow: registered
// stake credentials and DReps with the deposit the ledger stored for them, and
// registered pools. Rule names follow a released node with protocol 11.

export interface CertState {
  /** credentialKey → stored deposit */
  accounts: Map<string, bigint>;
  dreps: Map<string, bigint>;
  /** pool id hex */
  pools: Set<string>;
}

export function initialCertState(opts: { stakeKeyHash: Uint8Array; stakeRegistered: boolean; drepKeyHash: Uint8Array; drepRegistered: boolean; params: ProtocolParams }): CertState {
  const state: CertState = { accounts: new Map(), dreps: new Map(), pools: new Set() };
  if (opts.stakeRegistered) state.accounts.set(credentialKey({ isScript: false, hash: opts.stakeKeyHash }), opts.params.keyDeposit);
  if (opts.drepRegistered) state.dreps.set(credentialKey({ isScript: false, hash: opts.drepKeyHash }), opts.params.drepDeposit);
  return state;
}

const coin = (c: bigint) => `Coin ${c}`;

/** A credential roughly as Show prints it in a node's error: KeyHashObj (KeyHash {unKeyHash = "<hex>"}) or ScriptHashObj (ScriptHash "<hex>"). */
function showCredential(c: Credential): string {
  const hex = bytesToHex(c.hash);
  return c.isScript ? `ScriptHashObj (ScriptHash "${hex}")` : `KeyHashObj (${showKeyHash(c.hash)})`;
}

function showKeyHash(hash: Uint8Array): string {
  return `KeyHash {unKeyHash = "${bytesToHex(hash)}"}`;
}

/** The UTXO view: deposits and refunds of the whole transaction against the state before it. */
export function depositsAndRefunds(facts: TxFacts, state: CertState, params: ProtocolParams): { deposits: bigint; refunds: bigint } {
  // Deposits: Conway TxCert.hs conwayTotalDepositsTxCerts (Shelley TxCert.hs shelleyTotalDepositsTxCerts
  // plus conwayDRepDepositsTxCerts) and Conway TxBody.hs conwayProposalsDeposits. Every amount comes
  // from the protocol parameters, the certificate fields are checked by DELEG, GOVCERT and GOV.
  let deposits = BigInt(facts.proposalDeposits.length) * params.govActionDeposit;
  const newPools = new Set<string>();
  // Refunds: Shelley TxCert.hs shelleyTotalRefundsTxCerts plus Conway TxCert.hs conwayDRepRefundsTxCerts.
  let refunds = 0n;
  const registeredHere = new Set<string>();
  for (const cert of facts.certificates) {
    switch (cert.kind) {
      case 'accountRegistration':
        deposits += params.keyDeposit;
        registeredHere.add(credentialKey(cert.credential));
        break;
      case 'drepRegistration':
        deposits += params.drepDeposit;
        break;
      case 'poolRegistration': {
        // Only the first registration of a pool pays, a pool already in the state re-registers for free.
        const id = bytesToHex(cert.poolId);
        if (!state.pools.has(id) && !newPools.has(id)) {
          newPools.add(id);
          deposits += params.poolDeposit;
        }
        break;
      }
      case 'accountUnregistration': {
        const key = credentialKey(cert.credential);
        // Registered earlier in this transaction: the deposit it just paid. Otherwise the deposit
        // stored before the transaction, looked up in that state even after an earlier
        // unregistration in the same transaction, and 0 for an unknown credential.
        if (registeredHere.delete(key)) refunds += params.keyDeposit;
        else refunds += state.accounts.get(key) ?? 0n;
        break;
      }
      case 'drepUnregistration':
        refunds += cert.refund;
        break;
      default:
        break;
    }
  }
  return { deposits, refunds };
}

/** CERTS (DELEG, POOL, GOVCERT) in body order, then GOV per proposal: return account, deposit, network. */
export function certificateFailures(facts: TxFacts, state: CertState, params: ProtocolParams, networkId: 0 | 1): Failure[] {
  const failures: Failure[] = [];
  const deleg = (rule: string, detail: string) => failures.push({ path: PATH.DELEG, rule, detail });
  const govCert = (rule: string, detail: string) => failures.push({ path: PATH.GOVCERT, rule, detail });
  // Conway Certs.hs conwayCertsTransition runs every certificate against the state the
  // earlier ones left, so a registration and an unregistration in one transaction see each other.
  let current = state;
  for (const cert of facts.certificates) {
    switch (cert.kind) {
      case 'accountRegistration': {
        // Conway Deleg.hs ConwayRegCert and ConwayRegDelegCert: deposit field first (certificate 0
        // has none), then the registration. DepositIncorrectDELEG applies from protocol 11. The
        // duplicate registration keeps its released name StakeKeyRegisteredDELEG, the ledger's
        // master branch renamed it to DelegAccountAlreadyRegistered.
        if (cert.deposit !== undefined && cert.deposit !== params.keyDeposit) {
          deleg('DepositIncorrectDELEG', mismatch('RelEQ', coin(cert.deposit), coin(params.keyDeposit)));
        }
        if (current.accounts.has(credentialKey(cert.credential))) deleg('StakeKeyRegisteredDELEG', showCredential(cert.credential));
        break;
      }
      case 'accountUnregistration': {
        // Conway Deleg.hs ConwayUnRegCert: a refund field only counts for a registered credential.
        const stored = current.accounts.get(credentialKey(cert.credential));
        if (stored === undefined) deleg('StakeKeyNotRegisteredDELEG', showCredential(cert.credential));
        else if (cert.refund !== undefined && cert.refund !== stored) deleg('RefundIncorrectDELEG', mismatch('RelEQ', coin(cert.refund), coin(stored)));
        break;
      }
      case 'delegation':
        // Conway Deleg.hs ConwayDelegCert. Whether the target pool or DRep exists is not followed here.
        if (!current.accounts.has(credentialKey(cert.credential))) deleg('StakeKeyNotRegisteredDELEG', showCredential(cert.credential));
        break;
      case 'poolRetirement':
        // Shelley Pool.hs RetirePool, the rule Conway uses for POOL. Registration and re-registration always pass here.
        if (!current.pools.has(bytesToHex(cert.poolId))) {
          failures.push({ path: PATH.POOL, rule: 'StakePoolNotRegisteredOnKeyPOOL', detail: showKeyHash(cert.poolId) });
        }
        break;
      case 'drepRegistration':
        // Conway GovCert.hs ConwayRegDRep: registration first, then the deposit field.
        if (current.dreps.has(credentialKey(cert.credential))) govCert('ConwayDRepAlreadyRegistered', showCredential(cert.credential));
        if (cert.deposit !== params.drepDeposit) govCert('ConwayDRepIncorrectDeposit', mismatch('RelEQ', coin(cert.deposit), coin(params.drepDeposit)));
        break;
      case 'drepUnregistration': {
        // Conway GovCert.hs ConwayUnRegDRep: the refund must equal the deposit the DRep paid.
        const stored = current.dreps.get(credentialKey(cert.credential));
        if (stored === undefined) govCert('ConwayDRepNotRegistered', showCredential(cert.credential));
        else if (cert.refund !== stored) govCert('ConwayDRepIncorrectRefund', mismatch('RelEQ', coin(cert.refund), coin(stored)));
        break;
      }
      case 'drepUpdate':
        // Conway GovCert.hs ConwayUpdateDRep
        if (!current.dreps.has(credentialKey(cert.credential))) govCert('ConwayDRepNotRegistered', showCredential(cert.credential));
        break;
      default:
        // Pool registration always passes here. Committee certificates are not followed, deprecated ones never get this far.
        break;
    }
    current = applyCertificates(current, { ...facts, certificates: [cert] }, params);
  }
  // Conway Gov.hs processProposal, one proposal after the other, against the state CERTS left
  // (Ledger.hs hands certStateAfterCERTS to GOV). The return account check applies after the
  // bootstrap phase of protocol 9, the network check always, with the network read from bit 0 of
  // the header as the node does. Only the credential of the account counts for the first. Accounts of other wallets start unregistered, so a proposal returning
  // to one is refused here.
  const gov = (rule: string, detail: string) => failures.push({ path: PATH.GOV, rule, detail });
  facts.proposalReturnAccounts.forEach((account, i) => {
    const deposit = facts.proposalDeposits[i]!;
    if (!current.accounts.has(credentialKey({ isScript: account[0]! >> 4 === 15, hash: account.slice(1) }))) {
      gov('ProposalReturnAccountDoesNotExist', toBech32(account));
    }
    if (deposit !== params.govActionDeposit) gov('ProposalDepositIncorrect', mismatch('RelEQ', coin(deposit), coin(params.govActionDeposit)));
    if (headerNetwork(account) !== networkId) gov('ProposalProcedureNetworkIdMismatch', `{account: ${toBech32(account)}, expected: ${networkId === 1 ? 'Mainnet' : 'Testnet'}}`);
  });
  return failures;
}

/** The state after a valid transaction. Pure. */
export function applyCertificates(state: CertState, facts: TxFacts, params: ProtocolParams): CertState {
  const next: CertState = { accounts: new Map(state.accounts), dreps: new Map(state.dreps), pools: new Set(state.pools) };
  for (const cert of facts.certificates) {
    switch (cert.kind) {
      case 'accountRegistration':
        // Conway Deleg.hs registerConwayAccount stores keyDeposit, whatever the certificate field says.
        next.accounts.set(credentialKey(cert.credential), params.keyDeposit);
        break;
      case 'accountUnregistration':
        next.accounts.delete(credentialKey(cert.credential));
        break;
      case 'drepRegistration':
        // Conway GovCert.hs ConwayRegDRep stores drepDeposit from the protocol parameters.
        next.dreps.set(credentialKey(cert.credential), params.drepDeposit);
        break;
      case 'drepUnregistration':
        next.dreps.delete(credentialKey(cert.credential));
        break;
      case 'poolRegistration':
        next.pools.add(bytesToHex(cert.poolId));
        break;
      case 'poolRetirement':
        // Shelley Pool.hs only schedules the retirement, POOLREAP removes the pool at an epoch
        // boundary. Without an epoch clock the pool stays registered.
        break;
      default:
        break;
    }
  }
  return next;
}
