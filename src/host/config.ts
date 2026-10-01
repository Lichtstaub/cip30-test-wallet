// Node side. Turns the friendly WalletOptions into the JSON PageConfig,
// deriving keys here so the page never needs bip39 or BIP32 code.
import { cip129DRepId, toBech32, walletAddresses } from '../core/addresses.js';
import { bytesToHex, hexToBytes, isHex } from '../core/bytes.js';
import { decode } from '../core/cbor/decode.js';
import { keyHash } from '../core/hash.js';
import { publicKey } from '../core/keys.js';
import { deriveAccount, type DerivedAccount } from '../derive/index.js';
import { MAX_UINT64, parseAssetUnits } from '../core/value.js';
import { submitRejectedProblem, type OwnedUtxoConfig, type PageConfig, type QuirkConfig, type UtxoExtras } from '../page/config.js';
import { isPlutusDataBytes } from '../core/cbor-shapes.js';
import { isScriptRef } from '../core/scripts.js';
import { resolveProtocolParams, type ProtocolParams, type ProtocolParamsInput } from './protocol-params.js';

/** Public test vector from the CSL documentation. Holds no funds, safe to ship. */
export const DEFAULT_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice';

/** The project logo as an inline SVG (media/logo.svg), so a dApp rendering <img src> does not re-request the document. */
export const DEFAULT_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%230033ad"/><path d="M17 16c-4 0-5 2-5 5v6c0 3-1 5-4 5 3 0 4 2 4 5v6c0 3 1 5 5 5M47 16c4 0 5 2 5 5v6c0 3 1 5 4 5-3 0-4 2-4 5v6c0 3-1 5-5 5" fill="none" stroke="%23fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="21" y="24" width="22" height="16" rx="3" fill="%23fff"/><circle cx="37" cy="32" r="2.5" fill="%230033ad"/></svg>';

type UtxoExtrasInput = Omit<UtxoExtras, 'assets'> & { assets?: Record<string, number | bigint | string> };
type ForeignUtxoInput = { txId: string; index: number; addressHex: string; lovelace: number | bigint | string } & UtxoExtrasInput;

export interface WalletOptions {
  name?: string;
  displayName?: string;
  icon?: string;
  networkId?: 0 | 1;
  mnemonic?: string;
  accountIndex?: number;
  /** Whether the fixture installs the provider into the page at all. Defaults to true. */
  install?: boolean;
  utxos?: ({ lovelace: number | bigint | string } & UtxoExtrasInput)[];
  foreignUtxos?: ForeignUtxoInput[];
  quirks?: QuirkConfig;
  /** CIP-95: report the stake key as registered. Defaults to false, a fresh wallet. */
  stakeRegistered?: boolean;
  /**
   * state: apply every submitted transaction to the wallet's UTxOs and registration (default true).
   * checks: submitTx refuses what a Conway node refuses, with TxSendError Failure. Needs state and
   * the ledger in Node of the Playwright fixture or attachWallet (default false).
   * With checks only: protocolParams replaces single parameters of the network's defaults,
   * currentSlot is the slot the validity interval is checked against (no validity check without it),
   * drepRegistered counts the wallet's DRep as registered with drepDeposit (default false).
   */
  ledger?: { state?: boolean; checks?: boolean; protocolParams?: ProtocolParamsInput; currentSlot?: number | bigint; drepRegistered?: boolean };
}

/** What the ledger checks need beyond the page config, resolved and validated in Node. */
export interface LedgerChecksConfig {
  params: ProtocolParams;
  /** Undefined means no validity interval check. */
  currentSlot: bigint | undefined;
  drepRegistered: boolean;
}

export interface PreparedWallet {
  config: PageConfig;
  addresses: { payment: string; reward: string };
  paymentPublicKeyHex: string;
  stakePublicKeyHex: string;
  drepPublicKeyHex: string;
  drepKeyHashHex: string;
  drepId: string;
  /** Set exactly when walletOptions.ledger.checks is true. */
  ledgerChecks?: LedgerChecksConfig;
}

function lovelaceString(v: number | bigint | string): string {
  if (typeof v !== 'number' && typeof v !== 'bigint' && typeof v !== 'string') {
    throw new Error(`lovelace must be a non-negative integer, got ${String(v)}`);
  }
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  }
  if (n < 0n) throw new Error(`lovelace must be a non-negative integer, got ${v}`);
  return n.toString();
}

/** Checks the optional output parts in Node, so a bad entry fails here with its path, not later in the page. */
function validateUtxoExtras(u: UtxoExtrasInput, where: string): UtxoExtras {
  const out: UtxoExtras = {};
  if (u.assets !== undefined) {
    if (typeof u.assets !== 'object' || u.assets === null || Array.isArray(u.assets)) {
      throw new Error(`${where}.assets must be an object of unit to quantity`);
    }
    const units: Record<string, string> = {};
    for (const [unit, quantity] of Object.entries(u.assets)) {
      if (typeof quantity === 'number' && !Number.isSafeInteger(quantity)) {
        throw new Error(`${where}.assets: quantity for ${unit} must be a safe integer, pass larger values as bigint or string`);
      }
      units[unit] = String(quantity);
    }
    let parsed;
    try {
      parsed = parseAssetUnits(units);
    } catch (error) {
      throw new Error(`${where}.assets: ${(error as Error).message}`);
    }
    out.assets = {};
    for (const [policy, names] of parsed) for (const [name, quantity] of names) out.assets[policy + name] = quantity.toString();
  }
  if (u.datumHash !== undefined && u.inlineDatum !== undefined) throw new Error(`${where}: set either datumHash or inlineDatum, not both`);
  if (u.datumHash !== undefined) {
    if (!isHex(u.datumHash, 32)) throw new Error(`${where}.datumHash must be 32 bytes of hex`);
    out.datumHash = u.datumHash.toLowerCase();
  }
  if (u.inlineDatum !== undefined) {
    const hex = oneCborItem(u.inlineDatum, `${where}.inlineDatum`);
    if (!isPlutusDataBytes(hexToBytes(hex))) throw new Error(`${where}.inlineDatum must be the CBOR of plutus_data`);
    out.inlineDatum = hex;
  }
  if (u.scriptRef !== undefined) {
    const hex = oneCborItem(u.scriptRef, `${where}.scriptRef`);
    // The same reader signTx uses, so a script reference the wallet accepts here always resolves there.
    if (!isScriptRef(hexToBytes(hex))) {
      throw new Error(`${where}.scriptRef must be the CBOR of script = [0, native_script] / [1 to 3, plutus script bytes]`);
    }
    out.scriptRef = hex;
  }
  return out;
}

/** The balance is one CBOR value, so the sum of every asset over all owned UTxOs must fit as well. */
function checkOwnedSums(utxos: OwnedUtxoConfig[]): void {
  const sums = new Map<string, bigint>();
  let lovelace = 0n;
  for (const u of utxos) {
    lovelace += BigInt(u.lovelace);
    for (const [unit, quantity] of Object.entries(u.assets ?? {})) sums.set(unit, (sums.get(unit) ?? 0n) + BigInt(quantity));
  }
  if (lovelace > MAX_UINT64) throw new Error('utxos: the sum of lovelace is above 2^64 - 1');
  for (const [unit, sum] of sums) if (sum > MAX_UINT64) throw new Error(`utxos: the sum of ${unit} over all UTxOs is above 2^64 - 1`);
}

function oneCborItem(hex: unknown, where: string): string {
  if (!isHex(hex) || hex === '') throw new Error(`${where} must be hex`);
  try {
    decode(hexToBytes(hex));
  } catch {
    throw new Error(`${where} must be one complete CBOR item`);
  }
  return hex.toLowerCase();
}

/** Checked here so a bad entry fails in Node with a clear message, not later inside the page. */
function foreignUtxo(f: ForeignUtxoInput, i: number) {
  const where = `foreignUtxos[${i}]`;
  if (!isHex(f.txId, 32)) throw new Error(`${where}.txId must be 64 hex characters`);
  if (!Number.isSafeInteger(f.index) || f.index < 0) throw new Error(`${where}.index must be a non-negative integer, got ${f.index}`);
  // 29 bytes is the shortest Shelley address (enterprise or reward).
  if (!isHex(f.addressHex) || f.addressHex.length < 58) {
    throw new Error(`${where}.addressHex must be the hex bytes of an address`);
  }
  return {
    txId: f.txId.toLowerCase(),
    index: f.index,
    addressHex: f.addressHex.toLowerCase(),
    lovelace: lovelaceString(f.lovelace),
    ...validateUtxoExtras(f, where),
  };
}

const LEDGER_OPTIONS = ['state', 'checks', 'protocolParams', 'currentSlot', 'drepRegistered'] as const;
const CHECKS_ONLY_OPTIONS = ['protocolParams', 'currentSlot', 'drepRegistered'] as const;

/** Checked in Node, so a typo fails here instead of switching a check off without a word. */
function ledgerOptions(ledger: unknown, networkId: 0 | 1): { state: boolean; checks: LedgerChecksConfig | undefined } {
  if (ledger === undefined) return { state: true, checks: undefined };
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) throw new Error(`ledger must be an object, got ${String(ledger)}`);
  const options = ledger as NonNullable<WalletOptions['ledger']>;
  for (const key of Object.keys(options)) {
    if (!(LEDGER_OPTIONS as readonly string[]).includes(key)) throw new Error(`ledger.${key} is not a ledger option, known: ${LEDGER_OPTIONS.join(', ')}`);
  }
  // Only undefined takes the default. null fails the boolean check instead of switching a check off.
  const booleanOption = (key: 'state' | 'checks' | 'drepRegistered', fallback: boolean): boolean => {
    const value: unknown = options[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`ledger.${key} must be a boolean, got ${String(value)}`);
    return value;
  };
  const state = booleanOption('state', true);
  const checks = booleanOption('checks', false);
  if (!checks) {
    const stray = CHECKS_ONLY_OPTIONS.find((key) => options[key] !== undefined);
    if (stray) throw new Error(`ledger.${stray} only applies with ledger.checks: true`);
    return { state, checks: undefined };
  }
  if (!state) throw new Error('ledger.checks: true needs ledger.state: true, the checks judge each transaction against the state the ones before it left');
  const slot = options.currentSlot;
  const slotOk = (typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0) || (typeof slot === 'bigint' && slot >= 0n);
  if (slot !== undefined && (!slotOk || BigInt(slot) > MAX_UINT64)) throw new Error(`ledger.currentSlot must be a non-negative integer slot number as number or bigint, got ${String(slot)}`);
  const drepRegistered = booleanOption('drepRegistered', false);
  return {
    state,
    checks: { params: resolveProtocolParams(networkId, options.protocolParams), currentSlot: slot === undefined ? undefined : BigInt(slot), drepRegistered },
  };
}

function validateNetworkId(v: number): void {
  if (v !== 0 && v !== 1) throw new Error(`networkId must be 0 or 1, got ${v}`);
}

/** Repeated prepareWallet calls with the same mnemonic and accountIndex do not re-derive. */
const accountCache = new Map<string, DerivedAccount>();

function cachedDeriveAccount(mnemonic: string, accountIndex: number): DerivedAccount {
  const key = `${accountIndex}:${mnemonic}`;
  const cached = accountCache.get(key);
  if (cached) return cached;
  const account = deriveAccount(mnemonic, accountIndex);
  accountCache.set(key, account);
  return account;
}

export function prepareWallet(options: WalletOptions = {}): PreparedWallet {
  const networkId = options.networkId ?? 0;
  validateNetworkId(networkId);
  const accountIndex = options.accountIndex ?? 0;
  const account = cachedDeriveAccount(options.mnemonic ?? DEFAULT_MNEMONIC, accountIndex);
  const paymentPub = publicKey(account.payment);
  const stakePub = publicKey(account.stake);
  const drepPub = publicKey(account.drep);
  const drepHash = keyHash(drepPub);
  const { base, reward } = walletAddresses(networkId, paymentPub, stakePub);

  const utxos = (options.utxos ?? [{ lovelace: 10_000_000 }]).map((u, i) => ({ lovelace: lovelaceString(u.lovelace), ...validateUtxoExtras(u, `utxos[${i}]`) }));
  checkOwnedSums(utxos);
  const ledger = ledgerOptions(options.ledger, networkId);
  const rejected = submitRejectedProblem(options.quirks?.submitRejected);
  if (rejected) throw new Error(rejected);

  const config: PageConfig = {
    name: options.name ?? 'chw',
    displayName: options.displayName ?? 'Test Wallet',
    icon: options.icon ?? DEFAULT_ICON,
    networkId,
    keys: {
      payment: { kind: account.payment.kind, hex: bytesToHex(account.payment.bytes) },
      stake: { kind: account.stake.kind, hex: bytesToHex(account.stake.bytes) },
      drep: { kind: account.drep.kind, hex: bytesToHex(account.drep.bytes) },
    },
    utxos,
    foreignUtxos: (options.foreignUtxos ?? []).map(foreignUtxo),
    quirks: { ...(options.quirks ?? {}) },
    stakeRegistered: options.stakeRegistered ?? false,
    // checks only reaches the page when set, so the page can warn when it has no host ledger.
    ledger: ledger.checks ? { state: ledger.state, checks: true } : { state: ledger.state },
  };

  return {
    config,
    addresses: { payment: toBech32(base), reward: toBech32(reward) },
    paymentPublicKeyHex: bytesToHex(paymentPub),
    stakePublicKeyHex: bytesToHex(stakePub),
    drepPublicKeyHex: bytesToHex(drepPub),
    drepKeyHashHex: bytesToHex(drepHash),
    drepId: cip129DRepId(drepHash),
    ...(ledger.checks ? { ledgerChecks: ledger.checks } : {}),
  };
}
