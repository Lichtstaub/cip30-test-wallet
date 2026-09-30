import { bytesEqual, bytesToHex, hexToBytes } from './bytes.js';
import { encodeWitnessSet, parseTransaction, spentInputs, txHash, type ParsedBody, type ParsedTransaction, type TxInput } from './cbor/tx.js';
import { apiError, APIErrorCode, ChwError, TxSignErrorCode, txSignError } from './errors.js';
import { keyHash, publicKey, sign, verifiesOver, type SigningKey } from './keys.js';
import type { Ledger, Utxo } from './ledger.js';
import { deprecatedCertificate, requirements, type Role } from './requirements.js';
import { evaluateNativeScript, nativeKeyHashes, scriptsProvided } from './scripts.js';
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
  return Promise.all(spentInputs(body).map(({ input }) => ledger.resolveInput(input)));
}

/** Resolves every reference input once, in body order. */
export async function resolveReferenceInputs(body: ParsedBody, ledger: Ledger): Promise<Array<Utxo | undefined>> {
  return Promise.all(body.referenceInputs.map((input) => ledger.resolveInput(input)));
}

/** The first input the ledger does not know: spent inputs and collateral first, then reference inputs. */
function unresolvedInput(
  body: ParsedBody,
  resolvedInputs: ReadonlyArray<Utxo | undefined>,
  resolvedReferences: ReadonlyArray<Utxo | undefined>,
): { input: TxInput; label: string } | undefined {
  const spent = spentInputs(body).find((_, i) => !resolvedInputs[i]);
  if (spent) return spent;
  const index = resolvedReferences.findIndex((utxo) => !utxo);
  return index < 0 ? undefined : { input: body.referenceInputs[index]!, label: 'reference input' };
}

/**
 * Every item signTx refuses at partialSign: false, for the page's
 * partialSign: true warning. Same order as the error signTx would raise.
 */
export function unsupportedForms(body: ParsedBody, resolvedInputs: ReadonlyArray<Utxo | undefined>): string[] {
  return requirements(body, resolvedInputs).unsupported;
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
 * In this order:
 * A pre-Conway certificate raises TxSignError DeprecatedCertificate, at both
 * partialSign values.
 * partialSign false: an unsupported transaction form raises
 * CHW_UNSUPPORTED_TX_FORM, a harness diagnosis, never a fake wallet error.
 * An input, collateral input or reference input the ledger does not know
 * raises CHW_UNRESOLVED_INPUT, a script the transaction needs but does not
 * provide CHW_UNRESOLVED_SCRIPT, both in both modes.
 * partialSign false: every key requirement must be ours or already covered
 * by a valid witness, and every native script must hold with our keys plus
 * those witnesses, otherwise TxSignError ProofGeneration.
 * partialSign true: sign what is ours, ignore the rest, including
 * unsupported forms and native scripts that do not hold yet.
 *
 * The transaction arrives parsed, parseTxHex has already turned any
 * decoding failure into InvalidRequest.
 */
export async function signTx(parsed: ParsedTransaction, partialSign: boolean, ctx: SignContext): Promise<string> {
  const { body, hash, vkeyWitnesses } = parsed;
  // CIP-95: a pre-Conway certificate is refused regardless of consent and of partialSign.
  refuseDeprecatedCertificate(body);

  const resolvedInputs = await resolveInputs(body, ctx.ledger);
  const resolvedReferences = await resolveReferenceInputs(body, ctx.ledger);
  const reqs = requirements(body, resolvedInputs);
  if (!partialSign) {
    const [first] = reqs.unsupported;
    if (first) {
      throw new ChwError('CHW_UNSUPPORTED_TX_FORM', `${first} is not supported by this release, use partialSign: true to sign only the wallet's own share`);
    }
  }

  const missing = unresolvedInput(body, resolvedInputs, resolvedReferences);
  if (missing) {
    throw new ChwError(
      'CHW_UNRESOLVED_INPUT',
      `${missing.label} ${bytesToHex(missing.input.txId)}#${missing.input.index} is unknown to the mock ledger, add it to utxos or foreignUtxos`,
    );
  }

  const isUtxo = (utxo: Utxo | undefined): utxo is Utxo => utxo !== undefined;
  const { scripts, unreadable } = scriptsProvided(parsed.scripts, resolvedInputs.slice(0, body.inputs.length).filter(isUtxo), resolvedReferences.filter(isUtxo));
  const neededScripts = reqs.scripts.map((req) => {
    const script = scripts.find((s) => bytesEqual(s.hash, req.scriptHash));
    if (!script) {
      const unread = unreadable.length > 0 ? ` (the scriptRef of ${unreadable.join(', ')} could not be read)` : '';
      throw new ChwError(
        'CHW_UNRESOLVED_SCRIPT',
        `${req.source} needs script ${bytesToHex(req.scriptHash)}, which is neither in the witness set nor a reference script of an input or reference input${unread}. Attach it to the transaction, or add the UTxO holding it as scriptRef to utxos or foreignUtxos`,
      );
    }
    return { req, script };
  });

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

  // A native script holds for the key hashes the ledger sees among the witnesses. The wallet
  // contributes every own role the script names, like a real wallet in a multisig. At
  // partialSign false the script must hold with those roles plus the valid witnesses already
  // in the transaction. A Plutus script needs no wallet witness, the ledger runs it.
  for (const { req, script } of neededScripts) {
    if (!script.native) continue;
    // A committee credential is never the wallet's to witness, whatever keys its script names.
    // Such a script is evaluated with the existing witnesses only, so a committee script naming a
    // wallet key is refused at partialSign false even when the wallet signs that key for another requirement.
    const own = req.foreignOnly
      ? []
      : nativeKeyHashes(script.native)
          .map(roleOf)
          .filter((role): role is Role => role !== undefined);
    for (const role of own) needed.add(role);
    if (!partialSign) {
      const witnesses = [...covered, ...own.map((role) => roles.get(role)!.hash)];
      if (!evaluateNativeScript(script.native, witnesses, body.validityStart, body.ttl)) {
        throw txSignError(TxSignErrorCode.ProofGeneration, `wallet cannot satisfy native script ${bytesToHex(script.hash)} for ${req.source}`);
      }
    }
  }

  const signing = (['payment', 'stake', 'drep'] as const).filter((role) => needed.has(role)).map((role) => roles.get(role)!.key);
  return witnessSetFor(hash, signing);
}
