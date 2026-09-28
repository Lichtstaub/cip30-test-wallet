import { ed25519 } from '@noble/curves/ed25519.js';
import { isByronAddress, isScriptPayment, paymentHash } from './addresses.js';
import { bytesEqual, bytesToHex, hexToBytes } from './bytes.js';
import { encodeWitnessSet, parseTransaction, txHash, type ParsedBody, type ParsedTransaction } from './cbor/tx.js';
import { apiError, APIErrorCode, ChwError, TxSignErrorCode, txSignError } from './errors.js';
import { keyHash, publicKey, sign, type SigningKey } from './keys.js';
import type { Ledger, Utxo } from './ledger.js';
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

// The spike only reasons about these top-level transaction body keys. Every
// other key (certificates, mint, script data hash, collateral, reference
// inputs, governance fields, and anything unknown) is an unsupported form.
const SUPPORTED_BODY_KEYS = new Set<bigint>([0n, 1n, 2n, 3n, 5n, 7n, 8n, 14n, 15n]);

const BODY_KEY_NAMES: Record<string, string> = {
  '4': 'certificates',
  '6': 'update',
  '9': 'mint',
  '11': 'script data hash',
  '13': 'collateral inputs',
  '16': 'collateral return',
  '17': 'total collateral',
  '18': 'reference inputs',
  '19': 'voting procedures',
  '20': 'proposal procedures',
  '21': 'treasury value',
  '22': 'donation',
};

/** Resolves every input once, in body.inputs order, so callers never look an input up twice. */
export async function resolveInputs(body: ParsedBody, ledger: Ledger): Promise<Array<Utxo | undefined>> {
  return Promise.all(body.inputs.map((input) => ledger.resolveInput(input)));
}

/**
 * Every unsupported item in the body: a body key outside the allowlist, a
 * key input at a script or Byron address, a withdrawal with a script
 * credential. Named the way checkSupportedForm names the first offender, in
 * the same order, so a caller (the page's partialSign: true path) can warn
 * about everything signTx would otherwise have refused.
 */
export function unsupportedForms(body: ParsedBody, resolvedInputs: ReadonlyArray<Utxo | undefined>): string[] {
  const found: string[] = [];
  for (const key of body.bodyKeys) {
    if (!SUPPORTED_BODY_KEYS.has(key)) {
      const name = BODY_KEY_NAMES[key.toString()];
      found.push(`body key ${key}${name ? ` (${name})` : ''}`);
    }
  }
  for (const utxo of resolvedInputs) {
    if (!utxo) continue; // an unresolved input is CHW_UNRESOLVED_INPUT, raised later by the ownership loop
    if (isScriptPayment(utxo.address)) found.push('an input at a script address');
    if (isByronAddress(utxo.address)) found.push('an input at a Byron address');
  }
  for (const withdrawal of body.withdrawals) {
    if (withdrawal.isScript) found.push('a withdrawal with a script credential');
  }
  return found;
}

/**
 * Runs before the ownership decision and only when partialSign is false.
 * Raises CHW_UNSUPPORTED_TX_FORM naming the first unsupported item, if any.
 * With partialSign true the ownership loops below simply skip these instead.
 */
function checkSupportedForm(body: ParsedBody, resolvedInputs: ReadonlyArray<Utxo | undefined>, unsupported: (what: string) => never): void {
  const found = unsupportedForms(body, resolvedInputs);
  if (found.length > 0) unsupported(found[0]!);
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

export interface SignContext {
  payment: SigningKey;
  stake: SigningKey;
  ledger: Ledger;
}

/**
 * CIP-30 signTx for a single-account wallet over the transaction forms the
 * spike supports: key inputs, required signers, withdrawals, all listed in
 * SUPPORTED_BODY_KEYS. Returns only the witnesses this call created.
 *
 * partialSign false: every requirement must be ours or already covered by
 * a valid witness in the transaction, otherwise TxSignError ProofGeneration.
 * Any unsupported transaction form (an unlisted body key, a script or Byron
 * input, a script withdrawal) raises CHW_UNSUPPORTED_TX_FORM before the
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
  const resolvedInputs = await resolveInputs(body, ctx.ledger);
  const myPay = keyHash(publicKey(ctx.payment));
  const myStake = keyHash(publicKey(ctx.stake));
  // Key hashes that a valid witness already in the transaction vouches
  // for. A witness with the wrong vkey or signature length cannot be
  // valid, so it is dropped before ed25519 ever sees it.
  const covered = vkeyWitnesses
    .filter((w) => w.vkey.length === 32 && w.signature.length === 64 && ed25519.verify(w.signature, hash, w.vkey))
    .map((w) => keyHash(w.vkey));

  const needed = new Set<'payment' | 'stake'>();
  const isCovered = (hash: Uint8Array) => covered.some((c) => bytesEqual(c, hash));

  const refuse = (what: string): never => {
    throw txSignError(TxSignErrorCode.ProofGeneration, `wallet cannot sign for ${what}`);
  };
  const unsupported = (what: string): never => {
    throw new ChwError('CHW_UNSUPPORTED_TX_FORM', `${what} is not supported by this release, use partialSign: true to sign only the wallet's own share`);
  };

  if (!partialSign) checkSupportedForm(body, resolvedInputs, unsupported);

  for (const [i, input] of body.inputs.entries()) {
    const utxo = resolvedInputs[i];
    if (!utxo) {
      throw new ChwError(
        'CHW_UNRESOLVED_INPUT',
        `input ${bytesToHex(input.txId)}#${input.index} is unknown to the mock ledger, add it to utxos or foreignUtxos`,
      );
    }
    // Script and Byron inputs are unsupported forms, already rejected above
    // when partialSign is false. Here they are simply skipped.
    if (isScriptPayment(utxo.address) || isByronAddress(utxo.address)) continue;
    const hash = paymentHash(utxo.address);
    if (bytesEqual(hash, myPay)) needed.add('payment');
    else if (!partialSign && !isCovered(hash)) refuse('an input owned by another key');
  }

  for (const signer of body.requiredSigners) {
    if (bytesEqual(signer, myPay)) needed.add('payment');
    else if (bytesEqual(signer, myStake)) needed.add('stake');
    else if (!partialSign && !isCovered(signer)) refuse('a required signer the wallet does not hold');
  }

  for (const withdrawal of body.withdrawals) {
    // A script withdrawal is an unsupported form, already rejected above
    // when partialSign is false. Here it is simply skipped.
    if (withdrawal.isScript) continue;
    if (bytesEqual(withdrawal.hash, myStake)) needed.add('stake');
    else if (!partialSign && !isCovered(withdrawal.hash)) refuse('a withdrawal from another stake key');
  }

  const keys: SigningKey[] = [];
  if (needed.has('payment')) keys.push(ctx.payment);
  if (needed.has('stake')) keys.push(ctx.stake);
  return witnessSetFor(hash, keys);
}
