import { bytesToHex, hexToBytes } from './bytes.js';
import { encodeWitnessSet, txHash } from './cbor/tx.js';
import { publicKey, sign, type SigningKey } from './keys.js';

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
