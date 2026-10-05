import { bytesEqual, hexToBytes } from '../../src/core/bytes.js';
import type { TxInput } from '../../src/core/cbor/tx.js';
import type { Utxo } from '../../src/core/ledger.js';
import type { CertState } from '../../src/host/checks/cert-state.js';
import { buildCheckContext, type CheckContext } from '../../src/host/checks/context.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../../src/host/protocol-params.js';
import { defaultNetwork, SLOT_CONFIGS } from '../../src/host/slot-config.js';

/** No account, DRep or pool registered. */
export const emptyCertState = (): CertState => ({ accounts: new Map(), dreps: new Map(), pools: new Set() });

export type CheckOptions = Partial<Pick<CheckContext, 'params' | 'networkId' | 'currentSlot' | 'slotConfig' | 'certState'>>;

/** The context a node would see for this transaction: every UTxO in unspent is in the UTxO set, anything else is unknown or spent. Preprod parameters and calendar by default. */
export function checkContext(txHex: string, unspent: Utxo[], opts: CheckOptions = {}): CheckContext {
  const find = (input: TxInput) => unspent.find((u) => u.input.index === input.index && bytesEqual(u.input.txId, input.txId));
  return buildCheckContext(hexToBytes(txHex), find, {
    params: opts.params ?? DEFAULT_PROTOCOL_PARAMS[0],
    networkId: opts.networkId ?? 0,
    currentSlot: opts.currentSlot,
    slotConfig: opts.slotConfig ?? SLOT_CONFIGS[defaultNetwork(opts.networkId ?? 0)],
    certState: opts.certState ?? emptyCertState(),
  });
}
