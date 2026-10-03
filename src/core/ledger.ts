import { isScriptPayment, networkTag, paymentHash } from './addresses.js';
import { bytesEqual, bytesToHex } from './bytes.js';
import { Tagged, type CborValue } from './cbor/decode.js';
import { encode } from './cbor/encode.js';
import { parseTransaction, type ParsedTransaction, type TxInput } from './cbor/tx.js';
import { valueCbor, type MultiAsset } from './value.js';

export type Datum = { kind: 'hash'; hash: Uint8Array } | { kind: 'inline'; cbor: Uint8Array };

export interface Utxo {
  input: TxInput;
  address: Uint8Array;
  lovelace: bigint;
  assets?: MultiAsset;
  datum?: Datum;
  /** CBOR of script = [language tag, script bytes] */
  scriptRef?: Uint8Array;
}

/**
 * Everything signTx and the CIP-30 surface need from "the chain". The in-memory
 * implementation serves the page and, in the Playwright fixture, the host side of a binding.
 */
export interface Ledger {
  /** Any output this ledger knows, owned by the wallet or not. */
  resolveInput(input: TxInput): Promise<Utxo | undefined>;
  /** Outputs the wallet controls: configured outputs still unspent first, then outputs of submitted transactions, in submit order. */
  getWalletUtxos(): Promise<Utxo[]>;
  /** Record or broadcast a signed transaction, return its id (32 bytes). */
  submit(tx: Uint8Array): Promise<Uint8Array>;
  /** CIP-95: whether the wallet's stake key is registered, after every transaction submitted so far. */
  getStakeRegistered(): Promise<boolean>;
}

function sameInput(a: TxInput, b: TxInput): boolean {
  return a.index === b.index && bytesEqual(a.txId, b.txId);
}

/** The wallet side of the ledger state: which outputs it owns and which stake key it registers. */
export interface WalletCredentials {
  /** An output whose payment credential is this key hash becomes owned. */
  paymentKeyHash: Uint8Array;
  /** Registration certificates for this stake key hash change stakeRegistered. */
  stakeKeyHash: Uint8Array;
  /** Outputs to the payment key with another network tag stay foreign. */
  networkId: 0 | 1;
}

/** What building a wallet ledger needs: the base address for configured UTxOs and the key hashes, the network comes from the configuration. */
export type LedgerWallet = { baseAddress: Uint8Array } & Omit<WalletCredentials, 'networkId'>;

export interface LedgerState {
  owned: Utxo[];
  foreign: Utxo[];
  /** Outputs a submitted transaction consumed. signTx still resolves them: a wallet has seen them, a node refuses a second spend. */
  spent: Utxo[];
  stakeRegistered: boolean;
}

// Certificates whose second field is the stake credential they register (true) or unregister (false), Conway CDDL.
const STAKE_EFFECT = new Map<bigint, boolean>([
  [0n, true],
  [7n, true],
  [11n, true],
  [12n, true],
  [13n, true],
  [1n, false],
  [8n, false],
]);

/** A base, pointer or enterprise address on this network whose payment credential is this key hash. Script and Byron addresses never are. */
export function paysTo(address: Uint8Array, keyHash: Uint8Array, networkId: 0 | 1): boolean {
  // Header types 0 to 7 are base, pointer and enterprise addresses. Byron (8) and reward (14, 15) are above.
  if (address.length < 29 || address[0]! >> 4 > 7 || isScriptPayment(address)) return false;
  return networkTag(address) === networkId && bytesEqual(paymentHash(address), keyHash);
}

/**
 * The state after a transaction the node accepted, taken as accepted without
 * any check. A phase 2 valid transaction spends its inputs, creates its
 * outputs at txId#0 onwards and applies its certificates (Babbage UTXO rule
 * updateUTxOState, Conway LEDGER rule). An invalid one (is_valid false) spends
 * only its collateral inputs and creates only the collateral return, at
 * txId#(number of outputs) (Babbage mkCollateralTxIn).
 */
export function applyTransaction(state: LedgerState, tx: ParsedTransaction, wallet: WalletCredentials | undefined): LedgerState {
  const { body, hash, isValid } = tx;
  const consumed = isValid ? body.inputs : body.collateralInputs;
  const isConsumed = (u: Utxo) => consumed.some((input) => sameInput(u.input, input));
  const created: Utxo[] = isValid
    ? body.outputs.map((output, i) => ({ ...output, input: { txId: hash, index: BigInt(i) } }))
    : body.collateralReturn
      ? [{ ...body.collateralReturn, input: { txId: hash, index: BigInt(body.outputs.length) } }]
      : [];
  const isMine = (u: Utxo) => wallet !== undefined && paysTo(u.address, wallet.paymentKeyHash, wallet.networkId);

  let stakeRegistered = state.stakeRegistered;
  if (isValid && wallet) {
    for (const certificate of body.certificates) {
      const credential = certificate[1];
      const ownKey = Array.isArray(credential) && credential[0] === 0n && credential[1] instanceof Uint8Array && bytesEqual(credential[1], wallet.stakeKeyHash);
      const effect = ownKey ? STAKE_EFFECT.get(certificate[0] as bigint) : undefined;
      if (effect !== undefined) stakeRegistered = effect;
    }
  }

  return {
    owned: [...state.owned.filter((u) => !isConsumed(u)), ...created.filter(isMine)],
    foreign: [...state.foreign.filter((u) => !isConsumed(u)), ...created.filter((u) => !isMine(u))],
    spent: [...state.spent, ...state.owned.filter(isConsumed), ...state.foreign.filter(isConsumed)],
    stakeRegistered,
  };
}

export interface MemoryLedgerOptions {
  owned: Utxo[];
  foreign?: Utxo[];
  /** Without it no new output counts as owned and no certificate changes stakeRegistered. */
  wallet?: WalletCredentials;
  stakeRegistered?: boolean;
  /** Apply every submitted transaction to the state. Default true, false keeps the configured UTxOs and stake registration. */
  state?: boolean;
}

export class MemoryLedger implements Ledger {
  readonly submitted: Uint8Array[] = [];
  private current: LedgerState;
  private readonly applied = new Set<string>();

  constructor(private readonly opts: MemoryLedgerOptions) {
    this.current = { owned: [...opts.owned], foreign: [...(opts.foreign ?? [])], spent: [], stakeRegistered: opts.stakeRegistered ?? false };
  }

  async resolveInput(input: TxInput): Promise<Utxo | undefined> {
    return this.unspent(input) ?? this.current.spent.find((u) => sameInput(u.input, input));
  }

  /** The unspent output at this outpoint, owned or foreign. Undefined when unknown or already spent. */
  unspent(input: TxInput): Utxo | undefined {
    const { owned, foreign } = this.current;
    const at = (u: Utxo) => sameInput(u.input, input);
    return owned.find(at) ?? foreign.find(at);
  }

  async getWalletUtxos(): Promise<Utxo[]> {
    return [...this.current.owned];
  }

  async getStakeRegistered(): Promise<boolean> {
    return this.current.stakeRegistered;
  }

  async submit(tx: Uint8Array): Promise<Uint8Array> {
    // Parsed first, so a transaction that does not parse leaves no record behind.
    const parsed = parseTransaction(tx);
    this.submitted.push(tx);
    const id = bytesToHex(parsed.hash);
    // A second submit of the same transaction changes nothing.
    if (this.opts.state !== false && !this.applied.has(id)) {
      this.current = applyTransaction(this.current, parsed, this.opts.wallet);
      this.applied.add(id);
    }
    return parsed.hash;
  }
}

/**
 * The output the way cardano-js-sdk (Lace) writes it: the array form
 * [address, value] or [address, value, datum_hash] (Alonzo), the Babbage map
 * {0: address, 1: value, ?2: datum_option, ?3: script_ref} only when the
 * output carries an inline datum or a reference script. A coin-only output
 * stays [address, coin], byte-identical to earlier releases.
 */
export function encodeOutput(u: Utxo): CborValue {
  const value = valueCbor(u.lovelace, u.assets);
  if (u.datum?.kind === 'inline' || u.scriptRef) {
    const map = new Map<CborValue, CborValue>([
      [0n, u.address],
      [1n, value],
    ]);
    // datum_option = [0, hash32] / [1, #6.24(bytes .cbor plutus_data)]
    if (u.datum) map.set(2n, u.datum.kind === 'hash' ? [0n, u.datum.hash] : [1n, new Tagged(24n, u.datum.cbor)]);
    // script_ref = #6.24(bytes .cbor script)
    if (u.scriptRef) map.set(3n, new Tagged(24n, u.scriptRef));
    return map;
  }
  if (u.datum?.kind === 'hash') return [u.address, value, u.datum.hash];
  return [u.address, value];
}

/** transaction_unspent_output = [transaction_input, transaction_output] */
export function encodeUtxo(u: Utxo): Uint8Array {
  return encode([[u.input.txId, u.input.index], encodeOutput(u)] as never);
}
