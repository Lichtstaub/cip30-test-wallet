import { ed25519 } from '@noble/curves/ed25519.js';
import { isScriptPayment, paymentHash } from './addresses.js';
import { bytesEqual, bytesToHex, hexToBytes } from './bytes.js';
import { encodeWitnessSet, existingVKeyWitnesses, parseBody, txHash } from './cbor/tx.js';
import { ChwError, TxSignErrorCode, txSignError } from './errors.js';
import { keyHash, publicKey, sign, type SigningKey } from './keys.js';
import type { Ledger } from './ledger.js';

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
 * spike supports: key inputs, required signers, withdrawals. Returns only
 * the witnesses this call created.
 *
 * partialSign false: every requirement must be ours or already covered by
 * a valid witness in the transaction, otherwise TxSignError ProofGeneration.
 * partialSign true: sign what is ours, ignore the rest.
 * Script inputs and certificates are not evaluated yet. With partialSign
 * false they raise CHW_UNSUPPORTED_TX_FORM, a harness diagnosis, never a
 * fake wallet error. An input the ledger does not know raises
 * CHW_UNRESOLVED_INPUT in both modes.
 */
export function signTx(txHex: string, partialSign: boolean, ctx: SignContext): string {
  const tx = hexToBytes(txHex);
  const body = parseBody(tx);
  const bodyHash = txHash(tx);
  const myPay = keyHash(publicKey(ctx.payment));
  const myStake = keyHash(publicKey(ctx.stake));
  const needed = new Set<'payment' | 'stake'>();

  // Key hashes that a valid witness already in the transaction vouches for.
  const covered = existingVKeyWitnesses(tx)
    .filter((w) => ed25519.verify(w.signature, bodyHash, w.vkey))
    .map((w) => keyHash(w.vkey));
  const isCovered = (hash: Uint8Array) => covered.some((c) => bytesEqual(c, hash));

  const refuse = (what: string): never => {
    throw txSignError(TxSignErrorCode.ProofGeneration, `wallet cannot sign for ${what}`);
  };
  const unsupported = (what: string): never => {
    throw new ChwError('CHW_UNSUPPORTED_TX_FORM', `${what} are not evaluated in the milestone 1 spike, use partialSign: true to sign only the wallet's own share`);
  };

  for (const input of body.inputs) {
    const utxo = ctx.ledger.resolveInput(input);
    if (!utxo) {
      throw new ChwError(
        'CHW_UNRESOLVED_INPUT',
        `input ${bytesToHex(input.txId)}#${input.index} is unknown to the mock ledger, add it to utxos or foreignUtxos`,
      );
    }
    if (isScriptPayment(utxo.address)) {
      if (!partialSign) unsupported('script inputs');
      continue;
    }
    const hash = paymentHash(utxo.address);
    if (bytesEqual(hash, myPay)) needed.add('payment');
    else if (!partialSign && !isCovered(hash)) refuse('an input owned by another key');
  }

  for (const signer of body.requiredSigners) {
    if (bytesEqual(signer, myPay)) needed.add('payment');
    else if (bytesEqual(signer, myStake)) needed.add('stake');
    else if (!partialSign && !isCovered(signer)) refuse('a required signer the wallet does not hold');
  }

  for (const stakeHash of body.withdrawalStakeHashes) {
    if (bytesEqual(stakeHash, myStake)) needed.add('stake');
    else if (!partialSign && !isCovered(stakeHash)) refuse('a withdrawal from another stake key');
  }

  if (body.hasCertificates && !partialSign) unsupported('certificates');

  const keys: SigningKey[] = [];
  if (needed.has('payment')) keys.push(ctx.payment);
  if (needed.has('stake')) keys.push(ctx.stake);
  return signWithKeys(txHex, keys);
}
