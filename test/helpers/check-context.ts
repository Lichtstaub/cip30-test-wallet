import { bytesEqual, hexToBytes } from '../../src/core/bytes.js';
import { lookupInputs, parseTransaction, type TxInput } from '../../src/core/cbor/tx.js';
import type { Utxo } from '../../src/core/ledger.js';
import type { CertState } from '../../src/host/checks/cert-state.js';
import type { CheckContext } from '../../src/host/checks/context.js';
import { readTransaction } from '../../src/host/checks/read-tx.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../../src/host/protocol-params.js';

/** No account, DRep or pool registered. */
export const emptyCertState = (): CertState => ({ accounts: new Map(), dreps: new Map(), pools: new Set() });

export type CheckOptions = Partial<Pick<CheckContext, 'params' | 'networkId' | 'currentSlot' | 'certState'>>;

/** The context a node would see for this transaction: every UTxO in unspent is in the UTxO set, anything else is unknown or spent. Preprod parameters by default. */
export function checkContext(txHex: string, unspent: Utxo[], opts: CheckOptions = {}): CheckContext {
  const bytes = hexToBytes(txHex);
  const parsed = parseTransaction(bytes);
  const find = (input: TxInput) => unspent.find((u) => u.input.index === input.index && bytesEqual(u.input.txId, input.txId));
  return {
    parsed,
    facts: readTransaction(bytes, parsed),
    resolved: lookupInputs(parsed.body).map(({ input }) => find(input)),
    params: opts.params ?? DEFAULT_PROTOCOL_PARAMS[0],
    networkId: opts.networkId ?? 0,
    currentSlot: opts.currentSlot,
    certState: opts.certState ?? emptyCertState(),
  };
}
