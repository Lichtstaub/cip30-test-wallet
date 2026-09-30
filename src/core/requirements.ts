import { isByronAddress, isScriptPayment, paymentHash } from './addresses.js';
import { bytesToHex } from './bytes.js';
import type { CborValue } from './cbor/decode.js';
import { spentInputs, unwrapSet, type ParsedBody } from './cbor/tx.js';
import { apiError, APIErrorCode } from './errors.js';
import type { Utxo } from './ledger.js';

// Turns a parsed body into what must witness it. The witness table follows
// getVKeyWitnessConwayTxCert in cardano-ledger (Conway/TxCert.hs) and the
// CIP-95 rule that a wallet only witnesses with payment, stake and DRep keys.
// Certificate numbers follow the final Conway CDDL, not the CIP-95 draft table.

export type Role = 'payment' | 'stake' | 'drep';

export interface KeyRequirement {
  /** 28 byte key hash that must witness the transaction. */
  keyHash: Uint8Array;
  /** Where it comes from, for error messages and console.warn. */
  source: string;
  /** Pool and committee requirements. CIP-95 forbids the wallet to witness them, so they are never matched against its roles. */
  foreignOnly: boolean;
}

export interface ScriptRequirement {
  /** 28 byte script hash. */
  scriptHash: Uint8Array;
  source: string;
  /** Committee credentials. CIP-95 forbids the wallet to witness them, so their native scripts never get a wallet role. */
  foreignOnly: boolean;
}

export interface Requirements {
  keys: KeyRequirement[];
  scripts: ScriptRequirement[];
  /** Forms this release cannot reason about: unlisted body keys, Byron inputs, unknown certificate or voter types. */
  unsupported: string[];
}

const SUPPORTED_BODY_KEYS = new Set<bigint>([0n, 1n, 2n, 3n, 4n, 5n, 7n, 8n, 9n, 11n, 13n, 14n, 15n, 16n, 17n, 18n, 19n, 20n, 21n, 22n]);

// Key 6 (update) is gone from the Conway CDDL, an old builder may still write it.
const BODY_KEY_NAMES: Record<string, string> = {
  '6': 'update',
};

const CERTIFICATE_NAMES: Record<string, string> = {
  '0': 'account_registration',
  '1': 'account_unregistration',
  '2': 'delegation_to_stake_pool',
  '3': 'pool_registration',
  '4': 'pool_retirement',
  '5': 'genesis_key_delegation',
  '6': 'move_instantaneous_rewards',
  '7': 'account_registration_deposit',
  '8': 'account_unregistration_deposit',
  '9': 'delegation_to_drep',
  '10': 'delegation_to_stake_pool_and_drep',
  '11': 'account_registration_delegation_to_stake_pool',
  '12': 'account_registration_delegation_to_drep',
  '13': 'account_registration_delegation_to_stake_pool_and_drep',
  '14': 'committee_authorization',
  '15': 'committee_resignation',
  '16': 'drep_registration',
  '17': 'drep_unregistration',
  '18': 'drep_update',
};

// Certificates whose second field is the stake or DRep credential that must witness them.
const OWN_CREDENTIAL_CERTIFICATES = new Set<bigint>([1n, 2n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 16n, 17n, 18n]);
// Committee certificates carry the cold credential in the second field, never the wallet's to witness.
const COMMITTEE_CERTIFICATES = new Set<bigint>([14n, 15n]);
const DEPRECATED_CERTIFICATES = new Set<bigint>([5n, 6n]);

const VOTER_NAMES: Record<string, string> = {
  '0': 'constitutional committee hot key',
  '1': 'constitutional committee hot script',
  '2': 'DRep key',
  '3': 'DRep script',
  '4': 'stake pool',
};

const ACTION_NAMES: Record<string, string> = { '0': 'parameter_change', '2': 'treasury_withdrawals' };

function certificateName(index: bigint): string {
  const name = CERTIFICATE_NAMES[index.toString()];
  return `certificate ${index}${name ? ` (${name})` : ''}`;
}

function malformed(what: string): never {
  throw apiError(APIErrorCode.InvalidRequest, `malformed ${what}`);
}

function hash28(value: CborValue | undefined, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 28) malformed(what);
  return value;
}

/** The first pre-Conway certificate, found from its index alone, since Conway no longer defines its fields. */
export function deprecatedCertificate(body: ParsedBody): string | undefined {
  const found = body.certificates.find((c) => DEPRECATED_CERTIFICATES.has(c[0] as bigint));
  return found ? certificateName(found[0] as bigint) : undefined;
}

function parseCredential(value: CborValue | undefined, where: string): { isScript: boolean; hash: Uint8Array } {
  if (!Array.isArray(value) || value.length !== 2 || (value[0] !== 0n && value[0] !== 1n)) malformed(`credential in ${where}`);
  const hash = hash28(value[1], `credential hash in ${where}`);
  return { isScript: value[0] === 1n, hash };
}

function addCredential(value: CborValue | undefined, where: string, foreignOnly: boolean, out: Requirements): void {
  const { isScript, hash } = parseCredential(value, where);
  if (isScript) out.scripts.push({ scriptHash: hash, source: `${where} with a script credential`, foreignOnly });
  else out.keys.push({ keyHash: hash, source: where, foreignOnly });
}

// Array length per certificate, index included, from the Conway CDDL. The wallet
// checks the field count and every field that decides a witness. It does not
// check the types of the other fields (pool ids, coins, anchors), a node does.
const CERTIFICATE_ARITY: Record<string, number> = {
  '0': 2, '1': 2, '2': 3, '3': 10, '4': 3, '7': 3, '8': 3, '9': 3, '10': 4,
  '11': 4, '12': 4, '13': 5, '14': 3, '15': 3, '16': 4, '17': 3, '18': 3,
};

function addCertificate(cert: CborValue[], out: Requirements): void {
  const index = cert[0] as bigint;
  const where = certificateName(index);
  // Callers refuse these through deprecatedCertificate, there is nothing to require.
  if (DEPRECATED_CERTIFICATES.has(index)) return;
  const arity = CERTIFICATE_ARITY[index.toString()];
  if (arity === undefined) {
    out.unsupported.push(where);
    return;
  }
  if (cert.length !== arity) malformed(where);
  if (index === 0n) {
    // No witness during the Conway transition, TxCert.hs, not even for a script
    // credential. The credential is still checked, it is the certificate's only field.
    parseCredential(cert[1], where);
    return;
  }
  if (OWN_CREDENTIAL_CERTIFICATES.has(index)) return addCredential(cert[1], where, false, out);
  if (COMMITTEE_CERTIFICATES.has(index)) return addCredential(cert[1], where, true, out);
  if (index === 3n) {
    // [3, operator, vrf_keyhash, pledge, cost, margin, reward_account, pool_owners, relays, pool_metadata]
    out.keys.push({ keyHash: hash28(cert[1], `${where} operator`), source: `${where} operator`, foreignOnly: true });
    // unwrapSet throws a plain Error for a wrong shape, which must reach the dApp as InvalidRequest.
    let owners: CborValue[];
    try {
      owners = unwrapSet(cert[7]);
    } catch {
      return malformed(`pool owners in ${where}`);
    }
    for (const owner of owners) {
      out.keys.push({ keyHash: hash28(owner, `${where} owner`), source: `${where} owner`, foreignOnly: true });
    }
    return;
  }
  // index 4, pool_retirement = (4, pool_keyhash, epoch)
  out.keys.push({ keyHash: hash28(cert[1], where), source: where, foreignOnly: true });
}

/**
 * Every requirement the body creates, in body order: inputs, collateral
 * inputs, required signers, withdrawals, certificates, mint policies, votes,
 * proposals. An unresolved input is skipped here, signTx raises
 * CHW_UNRESOLVED_INPUT for it. The resolved list follows spentInputs order,
 * body.inputs first, then body.collateralInputs. Entries after those (the
 * reference inputs of resolveInputs) are not read.
 */
export function requirements(body: ParsedBody, resolvedInputs: ReadonlyArray<Utxo | undefined>): Requirements {
  const out: Requirements = { keys: [], scripts: [], unsupported: [] };

  for (const key of body.bodyKeys) {
    if (!SUPPORTED_BODY_KEYS.has(key)) {
      const name = BODY_KEY_NAMES[key.toString()];
      out.unsupported.push(`body key ${key}${name ? ` (${name})` : ''}`);
    }
  }

  for (const [i, { input, label }] of spentInputs(body).entries()) {
    const utxo = resolvedInputs[i];
    if (!utxo) continue;
    const where = `${label} ${bytesToHex(input.txId)}#${input.index}`;
    if (isByronAddress(utxo.address)) out.unsupported.push('an input at a Byron address');
    else if (!isScriptPayment(utxo.address)) out.keys.push({ keyHash: paymentHash(utxo.address), source: where, foreignOnly: false });
    // The ledger accepts only key-locked collateral (Alonzo UTXO rule ScriptsNotPaidUTxO) and never
    // runs a script for it, so a script-locked collateral input needs nothing. A node refuses such a
    // transaction, the wallet does not check validity.
    else if (label === 'input') out.scripts.push({ scriptHash: paymentHash(utxo.address), source: `${where} at a script address`, foreignOnly: false });
  }

  for (const signer of body.requiredSigners) {
    out.keys.push({ keyHash: signer, source: 'a required signer', foreignOnly: false });
  }

  for (const withdrawal of body.withdrawals) {
    if (withdrawal.isScript) out.scripts.push({ scriptHash: withdrawal.hash, source: 'a withdrawal with a script credential', foreignOnly: false });
    else out.keys.push({ keyHash: withdrawal.hash, source: 'a withdrawal', foreignOnly: false });
  }

  for (const cert of body.certificates) addCertificate(cert, out);

  for (const policy of body.mintPolicies) out.scripts.push({ scriptHash: policy, source: `mint policy ${bytesToHex(policy)}`, foreignOnly: false });

  for (const voter of body.voters) {
    const where = `vote by ${VOTER_NAMES[voter.type.toString()] ?? `voter type ${voter.type}`}`;
    if (voter.type === 2n) out.keys.push({ keyHash: hash28(voter.hash, where), source: where, foreignOnly: false });
    else if (voter.type === 0n || voter.type === 4n) out.keys.push({ keyHash: hash28(voter.hash, where), source: where, foreignOnly: true });
    else if (voter.type === 1n || voter.type === 3n) out.scripts.push({ scriptHash: hash28(voter.hash, where), source: where, foreignOnly: voter.type === 1n });
    else out.unsupported.push(where);
  }

  for (const [i, proposal] of body.proposals.entries()) {
    if (proposal.guardrail) {
      const name = ACTION_NAMES[proposal.actionIndex.toString()] ?? `action ${proposal.actionIndex}`;
      out.scripts.push({ scriptHash: hash28(proposal.guardrail, `guardrail script hash in proposal ${i}`), source: `proposal ${i} (${name}) with a guardrail script`, foreignOnly: false });
    }
  }

  return out;
}
