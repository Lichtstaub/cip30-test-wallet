// Everything the page receives is JSON. Keys are hex, lovelace are decimal
// strings, there are no callbacks. That is what keeps the quirk catalogue
// finite and the init script serialisable.

export interface KeyConfig {
  kind: 'seed' | 'extended';
  hex: string;
}

export interface OwnedUtxoConfig {
  lovelace: string;
}

export interface ForeignUtxoConfig {
  txId: string;
  index: number;
  addressHex: string;
  lovelace: string;
}

export const QUIRK_NAMES = ['lateInjection', 'enableRejected', 'signRejected', 'signHangs', 'signDataRejected'] as const;

export type QuirkName = (typeof QUIRK_NAMES)[number];

/** Quirks that only take effect while the provider is being installed, so setQuirk always refuses them. */
export const INSTALL_TIME_QUIRKS = ['lateInjection'] as const;

export interface QuirkConfig {
  /** Milliseconds before the provider appears in window.cardano. */
  lateInjection?: number;
  /** enable() throws APIError Refused, like a user closing the connect dialog. */
  enableRejected?: boolean;
  /** signTx() throws TxSignError UserDeclined, like a user cancelling the signature. */
  signRejected?: boolean;
  /** signTx() waits until the test calls release or reject. */
  signHangs?: boolean;
  /** signData() and cip95.signData() throw DataSignError UserDeclined, like a user cancelling the message prompt. */
  signDataRejected?: boolean;
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
}

export interface JournalEntry {
  method: string;
  args: unknown[];
  result?: unknown;
  error?: unknown;
  /** Date.now() when the call started. */
  t: number;
}
