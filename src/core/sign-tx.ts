import { bytesEqual, bytesToHex, hexToBytes } from './bytes.js';
import { encodeWitnessSet, parseTransaction, txHash, type ParsedBody, type ParsedTransaction } from './cbor/tx.js';
import { apiError, APIErrorCode, ChwError, TxSignErrorCode, txSignError } from './errors.js';
import { keyHash, publicKey, sign, verifiesOver, type SigningKey } from './keys.js';
import type { Ledger, Utxo } from './ledger.js';
import { deprecatedCertificate, formsOutOfScope, requirements, type Role } from './requirements.js';
import { parseHexArg } from './sign-data.js';

/**
 * The one way a transaction from a dApp enters the wallet, for signTx and
 * submitTx alike. Bad hex, malformed CBOR or a wrong shape become a plain
 * CIP-30 InvalidRequest carrying the reason, never a raw Error a dApp would
 * not know how to handle.
 */
export function parseTxHex(tx: unknown): { bytes: Uint8Array; parsed: ParsedTransaction } {
  const bytes = parseHexArg(tx, 'tx');
  try {
    return { bytes, parsed: parseTransaction(bytes) };
  } catch (error) {
    throw apiError(APIErrorCode.InvalidRequest, error instanceof Error ? error.message : 'tx could not be decoded');
  }
}

/** Resolves every input and then every collateral input once, in body order, so callers never look an input up twice. */
export async function resolveInputs(body: ParsedBody, ledger: Ledger): Promise<Array<Utxo | undefined>> {
  return Promise.all([...body.inputs, ...body.collateralInputs].map((input) => ledger.resolveInput(input)));
}

/**
 * Every item signTx refuses at partialSign: false, for the page's
 * partialSign: true warning. Same order as the error signTx would raise.
 */
export function unsupportedForms(body: ParsedBody, resolvedInputs: ReadonlyArray<Utxo | undefined>): string[] {
  return formsOutOfScope(requirements(body, resolvedInputs));
}

/**
 * Sign the transaction body hash with every given key and return the
 * witness set holding exactly those witnesses, hex encoded. No ownership
 * check, no existing witnesses. A raw primitive for tests and host code,
 * signTx itself signs the hash it already has.
 */
export function signWithKeys(txHex: string, keys: SigningKey[]): string {
  return witnessSetFor(txHash(hexToBytes(txHex)), keys);
}

function witnessSetFor(hash: Uint8Array, keys: SigningKey[]): string {
  const witnesses = keys.map((key) => ({ vkey: publicKey(key), signature: sign(key, hash) }));
  return bytesToHex(encodeWitnessSet(witnesses));
}

/** The one place a pre-Conway certificate becomes TxSignError DeprecatedCertificate. */
export function refuseDeprecatedCertificate(body: ParsedBody): void {
  const deprecated = deprecatedCertificate(body);
  if (deprecated) throw txSignError(TxSignErrorCode.DeprecatedCertificate, `${deprecated} is deprecated since Conway`);
}

export interface SignContext {
  payment: SigningKey;
  stake: SigningKey;
  /** Absent for a wallet without CIP-95, whose DRep requirements are then foreign. */
  drep?: SigningKey;
  ledger: Ledger;
}

/**
 * CIP-30 signTx for a single-account wallet over the forms requirements.ts
 * understands. Returns only the witnesses this call created.
 *
 * A pre-Conway certificate raises TxSignError DeprecatedCertificate first, at
 * both partialSign values.
 * partialSign false: every requirement must be ours or already covered by
 * a valid witness in the transaction, otherwise TxSignError ProofGeneration.
 * Any unsupported transaction form raises CHW_UNSUPPORTED_TX_FORM before the
 * ownership decision runs at all, a harness diagnosis, never a fake wallet
 * error.
 * partialSign true: sign what is ours, ignore the rest, including
 * unsupported forms.
 * An input the ledger does not know raises CHW_UNRESOLVED_INPUT in both
 * modes.
 *
 * The transaction arrives parsed, parseTxHex has already turned any
 * decoding failure into InvalidRequest.
 */
export async function signTx(parsed: ParsedTransaction, partialSign: boolean, ctx: SignContext): Promise<string> {
  const { body, hash, vkeyWitnesses } = parsed;
  // CIP-95: a pre-Conway certificate is refused regardless of consent and of partialSign.
  refuseDeprecatedCertificate(body);

  const resolvedInputs = await resolveInputs(body, ctx.ledger);
  const reqs = requirements(body, resolvedInputs);
  if (!partialSign) {
    const [first] = formsOutOfScope(reqs);
    if (first) {
      throw new ChwError('CHW_UNSUPPORTED_TX_FORM', `${first} is not supported by this release, use partialSign: true to sign only the wallet's own share`);
    }
  }

  const spentInputs = [...body.inputs.map((input) => ({ input, label: 'input' })), ...body.collateralInputs.map((input) => ({ input, label: 'collateral input' }))];
  for (const [i, { input, label }] of spentInputs.entries()) {
    if (!resolvedInputs[i]) {
      throw new ChwError(
        'CHW_UNRESOLVED_INPUT',
        `${label} ${bytesToHex(input.txId)}#${input.index} is unknown to the mock ledger, add it to utxos or foreignUtxos`,
      );
    }
  }

  const roles = new Map<Role, { key: SigningKey; hash: Uint8Array }>();
  const addRole = (role: Role, key: SigningKey) => roles.set(role, { key, hash: keyHash(publicKey(key)) });
  addRole('payment', ctx.payment);
  addRole('stake', ctx.stake);
  if (ctx.drep) addRole('drep', ctx.drep);
  const roleOf = (h: Uint8Array) => [...roles].find(([, own]) => bytesEqual(own.hash, h))?.[0];

  // Key hashes that a valid witness already in the transaction vouches for. A
  // witness with the wrong vkey or signature length cannot be valid, so it is
  // dropped before ed25519 ever sees it.
  const covered = vkeyWitnesses
    .filter((w) => verifiesOver(w, hash))
    .map((w) => keyHash(w.vkey));
  const isCovered = (h: Uint8Array) => covered.some((c) => bytesEqual(c, h));

  const needed = new Set<Role>();
  for (const req of reqs.keys) {
    const role = req.foreignOnly ? undefined : roleOf(req.keyHash);
    if (role) needed.add(role);
    else if (!partialSign && !isCovered(req.keyHash)) {
      throw txSignError(TxSignErrorCode.ProofGeneration, `wallet cannot sign for ${req.source}`);
    }
  }

  const signing = (['payment', 'stake', 'drep'] as const).filter((role) => needed.has(role)).map((role) => roles.get(role)!.key);
  return witnessSetFor(hash, signing);
}
