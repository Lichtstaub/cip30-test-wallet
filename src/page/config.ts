// Everything the page receives is JSON. Keys are hex, lovelace are decimal
// strings, there are no callbacks. That is what keeps the quirk catalogue
// finite and the init script serialisable.

export interface KeyConfig {
  kind: 'seed' | 'extended';
  hex: string;
}

/**
 * Optional parts of an output. Assets map units (policy id hex plus asset name
 * hex) to decimal quantities. datumHash and inlineDatum exclude each other.
 * scriptRef is the CBOR hex of [language tag, script bytes].
 */
export interface UtxoExtras {
  assets?: Record<string, string>;
  datumHash?: string;
  inlineDatum?: string;
  scriptRef?: string;
}

export interface OwnedUtxoConfig extends UtxoExtras {
  lovelace: string;
}

export interface ForeignUtxoConfig extends UtxoExtras {
  txId: string;
  index: number;
  addressHex: string;
  lovelace: string;
}

export const QUIRK_NAMES = [
  'lateInjection',
  'answersEveryKey',
  'enableRejected',
  'signRejected',
  'signHangs',
  'signDataRejected',
  'submitFails',
  'noCip95',
  'cip95NamespaceMissing',
  'cip95SignData',
  'coseAddress',
  'noCollateral',
  'submitRejected',
] as const;

export type QuirkName = (typeof QUIRK_NAMES)[number];

/** Quirks that only take effect while the provider is being installed, so setQuirk always refuses them. */
export const INSTALL_TIME_QUIRKS = ['lateInjection', 'answersEveryKey'] as const;

export interface QuirkConfig {
  /** Milliseconds before the provider appears in window.cardano. */
  lateInjection?: number;
  /** window.cardano answers every key it does not hold with this wallet, like the VESPR iOS in-app browser. Object.keys and the in operator still see only the real entries. */
  answersEveryKey?: boolean;
  /** enable() throws APIError Refused, like a user closing the connect dialog. */
  enableRejected?: boolean;
  /** signTx() throws TxSignError UserDeclined, like a user cancelling the signature. */
  signRejected?: boolean;
  /** signTx() waits until the test calls release or reject. */
  signHangs?: boolean;
  /** signData() and cip95.signData() throw DataSignError UserDeclined, like a user cancelling the message prompt. */
  signDataRejected?: boolean;
  /** submitTx() throws TxSendError Failure, like a node refusing the transaction. */
  submitFails?: boolean;
  /** The wallet does not support CIP-95: no extension announced, no namespace, like an older wallet. */
  noCip95?: boolean;
  /** supportedExtensions and getExtensions claim CIP-95, but the enabled api has no cip95 namespace. */
  cip95NamespaceMissing?: boolean;
  /** Which CIP-95 DRep form cip95.signData accepts. bareOnly rejects the type 6 address with UserDeclined, type6Only rejects the bare DRep ID with ProofGeneration. */
  cip95SignData?: 'bareOnly' | 'type6Only';
  /** bareKeyHash: DRep signatures carry the bare 28 byte key hash in the COSE address header, whatever form was requested. */
  coseAddress?: 'bareKeyHash';
  /** The api has neither getCollateral nor experimental.getCollateral, which the CIP-30 deprecation allows. Read at enable(). */
  noCollateral?: boolean;
  /**
   * submitTx() throws TxSendError Failure with this string as info, like a node
   * refusing the transaction. The ledger never sees the transaction, so its
   * state stays as it was. A malformed transaction is still InvalidRequest.
   */
  submitRejected?: string;
}

/** Why value cannot be quirks.submitRejected, undefined when it can. Undefined itself is fine, it switches the quirk off. */
export function submitRejectedProblem(value: unknown): string | undefined {
  if (value === undefined || (typeof value === 'string' && value !== '')) return undefined;
  return `quirks.submitRejected must be a non-empty string, the info the dApp receives, got ${String(value)}`;
}

export type HangableMethod = 'signTx';

export interface PageConfig {
  /** Key under window.cardano. */
  name: string;
  /** CIP-30 provider name shown by dApps. */
  displayName: string;
  icon: string;
  networkId: 0 | 1;
  keys: { payment: KeyConfig; stake: KeyConfig; drep: KeyConfig };
  utxos: OwnedUtxoConfig[];
  foreignUtxos: ForeignUtxoConfig[];
  quirks: QuirkConfig;
  /** CIP-95: whether the stake key counts as registered on chain. */
  stakeRegistered: boolean;
  /**
   * Ledger behaviour. state: apply every submitted transaction (default true).
   * binding: name of a host function the page calls instead of keeping its own
   * ledger, set by the Playwright fixture. checks: the host ledger checks every
   * submitted transaction, the page only warns when it has no binding to reach
   * it. Absent means the defaults.
   */
  ledger?: { state: boolean; binding?: string; checks?: boolean };
}

export interface JournalEntry {
  method: string;
  args: unknown[];
  result?: unknown;
  error?: unknown;
  /** Date.now() when the call started. */
  t: number;
}
