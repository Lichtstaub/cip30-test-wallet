import { bytesToHex } from '../../core/bytes.js';
import { lookupInputs, parseTransaction, type InputLabel, type ParsedTransaction, type TxInput } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';
import type { ProtocolParams } from '../protocol-params.js';
import type { CertState } from './cert-state.js';
import { readTransaction, type TxFacts } from './read-tx.js';

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

/** The context for a transaction's bytes. find answers for the UTxO set, undefined for an unknown or spent outpoint. Throws on bytes the parser or the reader refuses. */
export function buildCheckContext(
  bytes: Uint8Array,
  find: (input: TxInput) => Utxo | undefined,
  env: Pick<CheckContext, 'params' | 'networkId' | 'currentSlot' | 'certState'>,
): CheckContext {
  const parsed = parseTransaction(bytes);
  const facts = readTransaction(bytes, parsed);
  return { parsed, facts, resolved: lookupInputs(parsed.body).map(({ input }) => find(input)), ...env };
}

export interface KnownInput {
  input: TxInput;
  label: InputLabel;
  /** '<tx id hex>#<index>', the outpoint as the failures name it. */
  key: string;
  utxo: Utxo | undefined;
}

/** Every input in lookupInputs order with its outpoint key and the UTxO it resolved to. */
export function knownInputs(ctx: CheckContext): KnownInput[] {
  return lookupInputs(ctx.parsed.body).map(({ input, label }, i) => ({ input, label, key: `${bytesToHex(input.txId)}#${input.index}`, utxo: ctx.resolved[i] }));
}
