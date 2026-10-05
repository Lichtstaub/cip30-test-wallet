import { isScriptPayment, paymentHash } from '../../core/addresses.js';
import { bytesToHex } from '../../core/bytes.js';
import type { TxInput } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';
import { scriptsProvided } from '../../core/scripts.js';
import { knownInputs, type CheckContext } from './context.js';
import { headerNetwork } from './read-tx.js';

// The Plutus scripts a transaction runs and the redeemer pointer each one
// needs, after Conway UTxO.hs getConwayScriptsNeeded. Every purpose counts
// its items in the order the ledger keeps them, which is the Haskell Ord of a
// Set or Map key wherever the field is one:
// - Spend: the set of spend inputs, by tx id bytes, then index.
// - Reward: the withdrawal accounts, by network (Testnet before Mainnet), then
//   credential with ScriptHashObj before KeyHashObj (Credential.hs), then hash.
//   CBOR orders a key account (header e0) before a script account (f0).
// - Cert and Propose: position in the body.
// - Mint: the policy ids, by bytes.
// - Vote: the voters, CommitteeVoter before DRepVoter before StakePoolVoter
//   (Conway Governance/Procedures.hs), each script before key, then hash.
// An index counts every item of its field, scripts or not. A need exists only
// for a script that is needed, provided (witness set or reference script) and
// Plutus (Alonzo Rules/Utxow.hs hasExactSetOfRedeemers). The list follows
// getConwayScriptsNeeded: spend, reward, cert, mint, vote, propose.

export type RedeemerTag = 0n | 1n | 2n | 3n | 4n | 5n;

export interface PlutusNeed {
  tag: RedeemerTag;
  index: bigint;
  scriptHash: Uint8Array;
  language: 1 | 2 | 3;
  /** For a spend: the input and its resolved UTxO, so datum rules can read the datum. */
  spend?: { input: TxInput; utxo: Utxo };
  /** Human description for failure details, e.g. 'ConwaySpending (AsIx 0)'. */
  purpose: string;
}

// Conway Scripts.hs ConwayPlutusPurpose in tag order. The published node names the
// reward purpose ConwayRewarding, cardano-ledger-conway 1.23.0.0 renames it ConwayWithdrawing.
const PURPOSES = ['ConwaySpending', 'ConwayMinting', 'ConwayCertifying', 'ConwayRewarding', 'ConwayVoting', 'ConwayProposing'] as const;

// Certificates that never need a script: 0 (registration without deposit, Conway TxCert.hs
// getScriptWitnessConwayTxCert), 3 and 4 (pool ids are key hashes), 5 and 6 (gone in Conway).
const NO_SCRIPT_CERTIFICATES = new Set<bigint>([0n, 3n, 4n, 5n, 6n]);

// Voter order of Conway Governance/Procedures.hs: committee script, committee key, DRep script,
// DRep key, pool. Voter types of the Conway CDDL: 0 committee key, 1 committee script, 2 DRep key,
// 3 DRep script, 4 pool.
const VOTER_RANK: Record<string, number> = { '1': 0, '0': 1, '3': 2, '2': 3, '4': 4 };

const compareHex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareBigint = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Every redeemer the transaction needs: Plutus scripts that are needed and provided (witness or reference script). Native scripts never. */
export function plutusNeeds(ctx: CheckContext): PlutusNeed[] {
  const { parsed, facts } = ctx;
  const { body } = parsed;

  // Babbage UTxO.hs getBabbageScriptsProvided: the witness set and the reference scripts of spend and reference inputs.
  const sources = knownInputs(ctx).flatMap(({ label, utxo }) => (utxo ? [{ label, utxo }] : []));
  const plutus = new Map<string, 1 | 2 | 3>();
  for (const script of scriptsProvided(parsed.scripts, sources).scripts) {
    if (script.language !== 0) plutus.set(bytesToHex(script.hash), script.language);
  }

  const needs: PlutusNeed[] = [];
  const need = (tag: RedeemerTag, index: number, scriptHash: Uint8Array, spend?: PlutusNeed['spend']) => {
    const language = plutus.get(bytesToHex(scriptHash));
    if (language === undefined) return;
    const purpose = `${PURPOSES[Number(tag)]} (AsIx ${index})`;
    needs.push({ tag, index: BigInt(index), scriptHash, language, ...(spend ? { spend } : {}), purpose });
  };

  // Alonzo UTxO.hs getSpendingScriptsNeeded over the set of spend inputs. A repeated input counts once.
  const spends = new Map<string, { input: TxInput; utxo: Utxo | undefined }>();
  body.inputs.forEach((input, i) => spends.set(`${bytesToHex(input.txId)}#${input.index}`, { input, utxo: ctx.resolved[i] }));
  [...spends.values()]
    .sort((a, b) => compareHex(bytesToHex(a.input.txId), bytesToHex(b.input.txId)) || compareBigint(a.input.index, b.input.index))
    .forEach(({ input, utxo }, i) => {
      if (utxo && isScriptPayment(utxo.address)) need(0n, i, paymentHash(utxo.address), { input, utxo });
    });

  // Alonzo UTxO.hs getWithdrawingScriptsNeeded over the keys of the withdrawals map.
  const accounts = new Map(facts.withdrawals.map((w) => [bytesToHex(w.rewardAddress), w]));
  [...accounts.values()]
    .sort(
      (a, b) =>
        headerNetwork(a.rewardAddress) - headerNetwork(b.rewardAddress) ||
        Number(b.credential.isScript) - Number(a.credential.isScript) ||
        compareHex(bytesToHex(a.credential.hash), bytesToHex(b.credential.hash)),
    )
    .forEach((w, i) => {
      if (w.credential.isScript) need(3n, i, w.credential.hash);
    });

  // getConwayScriptsNeeded certifyingScriptsNeeded: position in the body, the credential in field 1.
  body.certificates.forEach((cert, i) => {
    const credential = cert[1];
    if (NO_SCRIPT_CERTIFICATES.has(cert[0] as bigint) || !Array.isArray(credential)) return;
    if (credential[0] === 1n && credential[1] instanceof Uint8Array) need(2n, i, credential[1]);
  });

  // Alonzo UTxO.hs getMintingScriptsNeeded over the set of policy ids.
  const policies = new Map(body.mintPolicies.map((p) => [bytesToHex(p), p]));
  [...policies].sort(([a], [b]) => compareHex(a, b)).forEach(([, policy], i) => need(1n, i, policy));

  // getConwayScriptsNeeded votingScriptsNeeded over the keys of the voting procedures map. A pool votes with its key hash, never with a script.
  const voters = new Map(body.voters.map((v) => [`${v.type}:${bytesToHex(v.hash)}`, v]));
  [...voters.values()]
    .sort((a, b) => (VOTER_RANK[a.type.toString()] ?? 5) - (VOTER_RANK[b.type.toString()] ?? 5) || compareHex(bytesToHex(a.hash), bytesToHex(b.hash)))
    .forEach((voter, i) => {
      if (voter.type === 1n || voter.type === 3n) need(4n, i, voter.hash);
    });

  // getConwayScriptsNeeded proposingScriptsNeeded: the guardrail of a parameter change or treasury withdrawal.
  body.proposals.forEach((proposal, i) => {
    if (proposal.guardrail) need(5n, i, proposal.guardrail);
  });

  return needs;
}
