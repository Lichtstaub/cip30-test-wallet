import { ed25519 } from '@noble/curves/ed25519.js';
import { isByronAddress, isScriptPayment, paymentHash } from './addresses.js';
import { bytesEqual, bytesToHex, hexToBytes } from './bytes.js';
import { assertTransactionShape, encodeWitnessSet, existingVKeyWitnesses, parseBody, txHash, type ParsedBody } from './cbor/tx.js';
import { apiError, APIErrorCode, ChwError, TxSignErrorCode, txSignError, type Cip30Error } from './errors.js';
import { keyHash, publicKey, sign, type SigningKey } from './keys.js';
import type { Ledger, Utxo } from './ledger.js';

/** True for the plain { code, info } shape every CIP-30 error already has. */
function isCip30ErrorShape(e: unknown): e is Cip30Error {
  return typeof e === 'object' && e !== null && 'code' in e && 'info' in e;
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
 * check, no existing witnesses. This is the raw primitive signTx builds on.
 */
export function signWithKeys(txHex: string, keys: SigningKey[]): string {
  const tx = hexToBytes(txHex);
  const hash = txHash(tx);
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
 * Anything that fails to decode or parse (bad hex, malformed CBOR, an
 * oversized or undersized witness) becomes a plain CIP-30 InvalidRequest,
 * never a raw Error a dApp would not know how to handle.
 */
export async function signTx(txHex: string, partialSign: boolean, ctx: SignContext): Promise<string> {
  let tx: Uint8Array;
  let body: ParsedBody;
  let myPay: Uint8Array;
  let myStake: Uint8Array;
  let covered: Uint8Array[];
  let resolvedInputs: Array<Utxo | undefined>;
  try {
    tx = hexToBytes(txHex);
    assertTransactionShape(tx);
    body = parseBody(tx);
    resolvedInputs = await resolveInputs(body, ctx.ledger);
    const bodyHash = txHash(tx);
    myPay = keyHash(publicKey(ctx.payment));
    myStake = keyHash(publicKey(ctx.stake));
    // Key hashes that a valid witness already in the transaction vouches
    // for. A witness with the wrong vkey or signature length cannot be
    // valid, so it is dropped before ed25519 ever sees it.
    covered = existingVKeyWitnesses(tx)
      .filter((w) => w.vkey.length === 32 && w.signature.length === 64 && ed25519.verify(w.signature, bodyHash, w.vkey))
      .map((w) => keyHash(w.vkey));
  } catch (e) {
    if (e instanceof ChwError || isCip30ErrorShape(e)) throw e;
    throw apiError(APIErrorCode.InvalidRequest, 'transaction could not be decoded');
  }

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
  return signWithKeys(txHex, keys);
}
