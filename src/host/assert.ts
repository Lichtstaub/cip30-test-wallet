import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesEqual, bytesToHex, hexToBytes } from '../core/bytes.js';
import { existingVKeyWitnesses, txHash } from '../core/cbor/tx.js';

/**
 * Proves the submitted transaction really carries this wallet's signature
 * over its own body hash. Recording submitTx alone proves nothing, a dApp
 * could submit the unsigned transaction and still get a hash back.
 */
export function expectSignedBy(txHex: string, wallet: { paymentPublicKeyHex: string }): void {
  const tx = hexToBytes(txHex);
  const hash = txHash(tx);
  const pub = hexToBytes(wallet.paymentPublicKeyHex);
  const ok = existingVKeyWitnesses(tx).some((w) => bytesEqual(w.vkey, pub) && ed25519.verify(w.signature, hash, pub));
  if (!ok) {
    throw new Error(`expectSignedBy: no valid witness from the wallet's payment key over body hash ${bytesToHex(hash)}`);
  }
}
