import type { ParsedTransaction } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';
import type { ProtocolParams } from '../protocol-params.js';
import type { CertState } from './cert-state.js';
import type { TxFacts } from './read-tx.js';

/** Everything a rule reads: the transaction, the UTxOs it names, the parameters and the certificate state before it. */
export interface CheckContext {
  parsed: ParsedTransaction;
  facts: TxFacts;
  /** lookupInputs order (inputs, collateral inputs, reference inputs), undefined when unknown or spent. */
  resolved: ReadonlyArray<Utxo | undefined>;
  params: ProtocolParams;
  networkId: 0 | 1;
  currentSlot: bigint | undefined;
  certState: CertState;
}
