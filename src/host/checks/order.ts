import { bytesToHex } from '../../core/bytes.js';
import type { TxInput } from '../../core/cbor/tx.js';

// The orders the ledger keeps its sets and maps in, for the checks that count positions or name items in order.

/** Plain ascending order, for lower case hex the byte order of hashes of one length. */
export const compare = <T extends string | bigint>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** '<tx id hex>#<index>', the outpoint as the failures name it. */
export { outpoint } from '../../core/cbor/tx.js';

/** TxIn order: tx id bytes, then index. */
export const compareInputs = (a: TxInput, b: TxInput): number => compare(bytesToHex(a.txId), bytesToHex(b.txId)) || compare(a.index, b.index);
