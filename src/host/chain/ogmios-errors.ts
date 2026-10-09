import { isHex } from '../../core/bytes.js';
import { addAsset, type MultiAsset } from '../../core/value.js';
import { coin, formatFailures, list, mismatch, network, PATH, showText, type Failure } from '../checks/failure.js';
import { formatValue, type Value } from '../checks/value-math.js';
import { jsonNatural, record } from './json.js';
import type { OgmiosError } from './provider.js';

// Ogmios answers a refused transaction with one JSON-RPC error, the failure its
// pickPredicateFailure ranks first, under a code of its own instead of the
// ledger rule name. RULES names the node rule for each code that a devnet run
// matched against cardano-cli on the same transaction, under the path the node
// reports it at. The details read the data Ogmios sends and follow the local
// checks wherever that data allows. A missing or malformed field leaves the
// failure without detail. Every other code keeps the text Ogmios sent.

type Data = Record<string, unknown>;
type Rule = (data: Data) => Failure | undefined;

/** Every item read, undefined when value is no non-empty array or one item does not read. */
function every(value: unknown, read: (item: unknown) => string | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const text = read(item);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

const hex = (bytes: number) => (value: unknown) => (isHex(value, bytes) ? value.toLowerCase() : undefined);
const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);
const listed = (items: string[] | undefined) => (items === undefined ? undefined : list(items));
const pair = (relation: 'RelEQ' | 'RelGTEQ' | 'RelLTEQ', supplied: string | undefined, expected: string | undefined) =>
  supplied === undefined || expected === undefined ? undefined : mismatch(relation, supplied, expected);
const withDetail = (path: readonly string[], rule: string, detail: string | undefined): Failure =>
  detail === undefined ? { path, rule } : { path, rule, detail };

/** The lovelace of Ogmios { ada: { lovelace } }. */
const lovelace = (value: unknown) => jsonNatural(record(record(value)?.['ada'])?.['lovelace']);
const coinText = (value: unknown) => {
  const amount = lovelace(value);
  return amount === undefined ? undefined : coin(amount);
};

/** An Ogmios Value: lovelace under ada, every other key a policy id over asset names and quantities. */
function valueText(json: unknown): string | undefined {
  const fields = record(json);
  const amount = lovelace(json);
  if (!fields || amount === undefined) return undefined;
  const assets: MultiAsset = new Map();
  for (const [policy, names] of Object.entries(fields)) {
    if (policy === 'ada') continue;
    const inner = record(names);
    if (!isHex(policy, 28) || !inner) return undefined;
    for (const [name, quantity] of Object.entries(inner)) {
      const q = jsonNatural(quantity);
      if (!isHex(name) || name.length > 64 || q === undefined) return undefined;
      addAsset(assets, policy.toLowerCase(), name.toLowerCase(), q);
    }
  }
  const value: Value = { coin: amount, assets };
  return formatValue(value);
}

/** '<tx id>#<index>' from Ogmios { transaction: { id }, index }. */
function outputReference(item: unknown): string | undefined {
  const ref = record(item);
  const id = record(ref?.['transaction'])?.['id'];
  const index = jsonNatural(ref?.['index']);
  return isHex(id, 32) && index !== undefined ? `${id.toLowerCase()}#${index}` : undefined;
}

/** SJust <hex> for a hash, SNothing for null, as the local integrity check writes a StrictMaybe. */
function maybeHash(value: unknown): string | undefined {
  if (value === null) return 'SNothing';
  return isHex(value, 32) ? `SJust ${value.toLowerCase()}` : undefined;
}

/** A validity bound: SJust (SlotNo n), or SNothing when Ogmios leaves it out. */
function bound(value: unknown): string | undefined {
  if (value === undefined || value === null) return 'SNothing';
  const slot = jsonNatural(value);
  return slot === undefined ? undefined : `SJust (SlotNo ${slot})`;
}

/** The local check's {invalidBefore, invalidHereafter, slot}. Ogmios calls the upper bound invalidAfter. */
function validity(data: Data): string | undefined {
  const interval = record(data['validityInterval']);
  const slot = jsonNatural(data['currentSlot']);
  if (!interval || slot === undefined) return undefined;
  const before = bound(interval['invalidBefore']);
  const after = bound(interval['invalidAfter']);
  if (before === undefined || after === undefined) return undefined;
  return `{invalidBefore: ${before}, invalidHereafter: ${after}, slot: SlotNo ${slot}}`;
}

/** ExUnits {mem, steps} from Ogmios { memory, cpu }. */
function exUnits(value: unknown): string | undefined {
  const units = record(value);
  const mem = jsonNatural(units?.['memory']);
  const steps = jsonNatural(units?.['cpu']);
  return mem === undefined || steps === undefined ? undefined : `ExUnits {mem: ${mem}, steps: ${steps}}`;
}

/** One output below its minimum. Ogmios sends the output, not its index, so the address names it. */
function fundedOutput(item: unknown): string | undefined {
  const entry = record(item);
  const address = text(record(entry?.['output'])?.['address']);
  const minimum = lovelace(entry?.['minimumRequiredValue']);
  return address === undefined || minimum === undefined ? undefined : `(${address}, ${coin(minimum)})`;
}

/**
 * 3124 also stands for WrongNetworkWithdrawal, WrongNetworkInTxBody and the governance
 * network checks. Only an address was matched against the node, every other entity
 * keeps the Ogmios text.
 */
function networkMismatch(data: Data): Failure | undefined {
  if (data['discriminatedType'] !== 'address') return undefined;
  const expected = data['expectedNetwork'] === 'mainnet' ? network(1) : data['expectedNetwork'] === 'testnet' ? network(0) : undefined;
  const addresses = every(data['invalidEntities'], text);
  const detail = expected === undefined || addresses === undefined ? undefined : `{expected: ${expected}, addresses: ${list(addresses)}}`;
  return withDetail(PATH.UTXO, 'WrongNetwork', detail);
}

// declaredSpending is what the is_valid flag promised: inputs for true, collaterals for false.
// Ogmios does not pass the script failure, so FailedUnexpectedly stands without its PlutusFailure list.
const TAG_MISMATCH = new Map<unknown, string>([
  ['inputs', '(IsValid True) FailedUnexpectedly'],
  ['collaterals', '(IsValid False) PassedUnexpectedly'],
]);

const RULES: ReadonlyMap<number, Rule> = new Map<number, Rule>([
  [3100, (d) => withDetail(PATH.UTXOW, 'InvalidWitnessesUTXOW', listed(every(d['invalidSignatories'], hex(32))))],
  [3101, (d) => withDetail(PATH.UTXOW, 'MissingVKeyWitnessesUTXOW', listed(every(d['missingSignatories'], hex(28))))],
  // The name the local check uses from protocol 11 on.
  [3113, (d) => withDetail(PATH.UTXOW, 'ScriptIntegrityHashMismatch', pair('RelEQ', maybeHash(d['providedScriptIntegrity']), maybeHash(d['computedScriptIntegrity'])))],
  [3117, (d) => withDetail(PATH.UTXO, 'BadInputsUTxO', listed(every(d['unknownOutputReferences'], outputReference)))],
  [3118, (d) => withDetail(PATH.UTXO, 'OutsideValidityIntervalUTxO', validity(d))],
  [3122, (d) => withDetail(PATH.UTXO, 'FeeTooSmallUTxO', pair('RelGTEQ', coinText(d['providedFee']), coinText(d['minimumRequiredFee'])))],
  [3123, (d) => withDetail(PATH.UTXO, 'ValueNotConservedUTxO', pair('RelEQ', valueText(d['valueConsumed']), valueText(d['valueProduced'])))],
  [3124, networkMismatch],
  [3125, (d) => withDetail(PATH.UTXO, 'BabbageOutputTooSmallUTxO', listed(every(d['insufficientlyFundedOutputs'], fundedOutput)))],
  [3134, (d) => withDetail(PATH.UTXO, 'ExUnitsTooBigUTxO', pair('RelLTEQ', exUnits(d['providedExecutionUnits']), exUnits(d['maximumExecutionUnits'])))],
  [3136, (d) => withDetail(PATH.UTXOS, 'ValidationTagMismatch', TAG_MISMATCH.get(d['declaredSpending']))],
  // Conway/Rules/Mempool.hs: the node refuses before the ledger rules, as the local checks do.
  [3997, (d) => withDetail(PATH.LEDGER, 'ConwayMempoolFailure', typeof d['error'] === 'string' ? showText(d['error']) : undefined)],
]);

/** The failure a node reports for this Ogmios error, or undefined for a code the table does not know. */
export function failureFromOgmios(error: OgmiosError): Failure | undefined {
  return RULES.get(error.code)?.(record(error.data) ?? {});
}

/** The CIP-30 info text: formatFailures([failure]) when known, 'Ogmios <code>: <message>' otherwise. */
export function rejectionInfo(error: OgmiosError): string {
  const failure = failureFromOgmios(error);
  return failure ? formatFailures([failure]) : `Ogmios ${error.code}: ${error.message}`;
}
