// Node side. Turns the friendly WalletOptions into the JSON PageConfig,
// deriving keys here so the page never needs bip39 or BIP32 code.
import { cip129DRepId, toBech32, walletAddresses } from '../core/addresses.js';
import { bytesToHex, hexToBytes, isHex } from '../core/bytes.js';
import { decode } from '../core/cbor/decode.js';
import { keyHash } from '../core/hash.js';
import { publicKey } from '../core/keys.js';
import { deriveAccount, type DerivedAccount } from '../derive/index.js';
import { MAX_UINT64, parseAssetUnits } from '../core/value.js';
import { submitFailsProblem, type OwnedUtxoConfig, type PageConfig, type QuirkConfig, type UtxoExtras } from '../page/config.js';
import { isPlutusDataBytes } from '../core/cbor-shapes.js';
import { isScriptRef } from '../core/scripts.js';
import { resolveProtocolParams, type ProtocolParams, type ProtocolParamsInput } from './protocol-params.js';
import { defaultNetwork, networkIdOf, SLOT_CONFIGS, type CardanoNetwork } from './slot-config.js';
import { KOIOS_URLS } from './chain/koios-urls.js';

/** Public test vector from the CSL documentation. Holds no funds, safe to ship. */
export const DEFAULT_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice';

/** The project logo as an inline SVG (media/logo.svg), so a dApp rendering <img src> does not re-request the document. */
export const DEFAULT_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%230033ad"/><path d="M17 16c-4 0-5 2-5 5v6c0 3-1 5-4 5 3 0 4 2 4 5v6c0 3 1 5 5 5M47 16c4 0 5 2 5 5v6c0 3 1 5 4 5-3 0-4 2-4 5v6c0 3-1 5-5 5" fill="none" stroke="%23fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="21" y="24" width="22" height="16" rx="3" fill="%23fff"/><circle cx="37" cy="32" r="2.5" fill="%230033ad"/></svg>';

type UtxoExtrasInput = Omit<UtxoExtras, 'assets'> & { assets?: Record<string, number | bigint | string> };
type ForeignUtxoInput = { txId: string; index: number; addressHex: string; lovelace: number | bigint | string } & UtxoExtrasInput;

/**
 * A chain the wallet's ledger reads and submits to instead of keeping UTxOs in memory.
 * ogmios: an Ogmios server over HTTP, such as a devnet or an own node.
 * koios: the public Koios API of the network, url replaces its default, token goes along as a bearer token.
 * allowMainnetSigning: signTx signs when the chain is mainnet. Default false, signTx then throws CHW_MAINNET_LOCKED.
 */
export type ChainOptions =
  | { provider: 'ogmios'; url: string; allowMainnetSigning?: boolean }
  | { provider: 'koios'; network: 'mainnet' | 'preprod' | 'preview'; url?: string; token?: string; allowMainnetSigning?: boolean };

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
   * drepRegistered counts the wallet's DRep as registered with drepDeposit (default false),
   * network picks the slot calendar Plutus scripts see (default preprod for networkId 0, mainnet for 1).
   * chain: UTxOs and the stake registration come from this chain provider and submitTx sends there.
   * Needs the ledger in Node and replaces utxos, foreignUtxos, stakeRegistered and the checks.
   */
  ledger?: {
    state?: boolean;
    checks?: boolean;
    protocolParams?: ProtocolParamsInput;
    currentSlot?: number | bigint;
    drepRegistered?: boolean;
    network?: CardanoNetwork;
    chain?: ChainOptions;
  };
}

/** What the ledger checks need beyond the page config, resolved and validated in Node. */
export interface LedgerChecksConfig {
  params: ProtocolParams;
  /** Undefined means no validity interval check. */
  currentSlot: bigint | undefined;
  drepRegistered: boolean;
  /** The slot calendar, it never changes the parameter defaults, those follow networkId. */
  network: CardanoNetwork;
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
  /** Set exactly when walletOptions.ledger.chain is given, validated, the Koios url filled in. Never part of config, it may hold a token. */
  chain?: ChainOptions;
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

const LEDGER_OPTIONS = ['state', 'checks', 'protocolParams', 'currentSlot', 'drepRegistered', 'network', 'chain'] as const;
const CHECKS_ONLY_OPTIONS = ['protocolParams', 'currentSlot', 'drepRegistered', 'network'] as const;

/** ledger.network, checked against networkId: a preprod calendar under mainnet addresses is a mistake in the options. */
function ledgerNetwork(value: unknown, networkId: 0 | 1): CardanoNetwork {
  if (value === undefined) return defaultNetwork(networkId);
  const known = Object.keys(SLOT_CONFIGS);
  if (typeof value !== 'string' || !known.includes(value)) throw new Error(`ledger.network must be one of ${known.join(', ')}, got ${String(value)}`);
  const network = value as CardanoNetwork;
  const expected = networkIdOf(network);
  if (networkId !== expected) throw new Error(`ledger.network ${network} needs networkId ${expected}, got networkId ${networkId}`);
  return network;
}

const CHAIN_OPTIONS = {
  ogmios: ['provider', 'url', 'allowMainnetSigning'],
  koios: ['provider', 'network', 'url', 'token', 'allowMainnetSigning'],
} as const;
const KOIOS_NETWORKS = ['mainnet', 'preprod', 'preview'] as const;
/** RFC 6750 b64token: a valid header value, so fetch never refuses it with an error that repeats it. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Why a chain replaces each checks-only option, so a new one needs a reason here. The chain is the
 * only source of UTxOs and registrations, the node checks every transaction itself.
 */
const LEDGER_OPTIONS_REPLACED_BY_CHAIN: Record<(typeof CHECKS_ONLY_OPTIONS)[number], string> = {
  protocolParams: 'ledger.protocolParams, the node uses its own protocol parameters',
  currentSlot: 'ledger.currentSlot, the node checks the validity interval against its own tip',
  drepRegistered: 'ledger.drepRegistered, the chain reports whether the DRep is registered',
  network: 'ledger.network, the node runs scripts with its own slot calendar',
};

/** Top-level options a chain replaces. Any value counts, an empty list and false as well. */
const WALLET_OPTIONS_REPLACED_BY_CHAIN = [
  ['utxos', "utxos, the wallet's UTxOs come from the chain"],
  ['foreignUtxos', 'foreignUtxos, the chain resolves every input'],
  ['stakeRegistered', 'stakeRegistered, the chain reports whether the stake key is registered'],
] as const;

/** An absolute http or https URL, as it came. The message never repeats the value, a URL can carry credentials. */
function chainUrl(value: unknown): string {
  let url: URL | undefined;
  try {
    url = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    // url stays undefined and fails below.
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('ledger.chain.url must be an absolute http or https URL such as http://localhost:1337');
  }
  // fetch would refuse such a URL later with only "request failed", so say why here.
  if (url.username !== '' || url.password !== '') {
    throw new Error('ledger.chain.url must not carry a username or a password, fetch refuses such a URL');
  }
  return value as string;
}

/** ledger.chain, strict like every ledger option. Koios without url gets the public URL of its network. */
function chainOptions(value: unknown, networkId: 0 | 1): ChainOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`ledger.chain must be an object, got ${String(value)}`);
  const options = value as Record<string, unknown>;
  const provider = options['provider'];
  if (provider !== 'ogmios' && provider !== 'koios') throw new Error(`ledger.chain.provider must be ogmios or koios, got ${String(provider)}`);
  const known: readonly string[] = CHAIN_OPTIONS[provider];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw new Error(`ledger.chain.${key} is not an option of provider ${String(provider)}, known: ${known.join(', ')}`);
  }
  const allow = options['allowMainnetSigning'];
  if (allow !== undefined && typeof allow !== 'boolean') throw new Error(`ledger.chain.allowMainnetSigning must be a boolean, got ${String(allow)}`);
  const signing = allow === undefined ? {} : { allowMainnetSigning: allow };
  if (provider === 'ogmios') {
    if (options['url'] === undefined) throw new Error('ledger.chain.url is required for provider ogmios, the address of the Ogmios server such as http://localhost:1337');
    return { provider: 'ogmios', url: chainUrl(options['url']), ...signing };
  }
  const network = options['network'];
  if (typeof network !== 'string' || !(KOIOS_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`ledger.chain.network must be one of ${KOIOS_NETWORKS.join(', ')}, got ${String(network)}`);
  }
  const koiosNetwork = network as (typeof KOIOS_NETWORKS)[number];
  const expected = koiosNetwork === 'mainnet' ? 1 : 0;
  if (networkId !== expected) throw new Error(`ledger.chain.network ${koiosNetwork} needs networkId ${expected}, got networkId ${networkId}`);
  const token = options['token'];
  // The messages never repeat the value, it is a secret.
  if (token !== undefined && (typeof token !== 'string' || token === '')) throw new Error('ledger.chain.token must be a non-empty string');
  if (typeof token === 'string' && !BEARER_TOKEN.test(token)) throw new Error('ledger.chain.token must be a bearer token of letters, digits and - . _ ~ + /, with = only at the end');
  const url = options['url'] === undefined ? KOIOS_URLS[koiosNetwork] : chainUrl(options['url']);
  return { provider: 'koios', network: koiosNetwork, url, ...(token === undefined ? {} : { token }), ...signing };
}

/** Checked in Node, so a typo fails here instead of switching a check off without a word. */
function ledgerOptions(ledger: unknown, networkId: 0 | 1): { state: boolean; checks?: LedgerChecksConfig; chain?: ChainOptions } {
  if (ledger === undefined) return { state: true };
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
  if (options.chain !== undefined) {
    const chain = chainOptions(options.chain, networkId);
    // Before the checks-only rule below, so each option names why a chain replaces it.
    if (!state) throw new Error('ledger.chain cannot be combined with ledger.state: false, the chain applies every transaction it accepts');
    if (checks) throw new Error('ledger.chain cannot be combined with ledger.checks: true, the node checks every transaction itself');
    for (const key of CHECKS_ONLY_OPTIONS) if (options[key] !== undefined) throw new Error(`ledger.chain cannot be combined with ${LEDGER_OPTIONS_REPLACED_BY_CHAIN[key]}`);
    return { state, chain };
  }
  if (!checks) {
    const stray = CHECKS_ONLY_OPTIONS.find((key) => options[key] !== undefined);
    if (stray) throw new Error(`ledger.${stray} only applies with ledger.checks: true`);
    return { state };
  }
  if (!state) throw new Error('ledger.checks: true needs ledger.state: true, the checks judge each transaction against the state the ones before it left');
  const slot = options.currentSlot;
  const slotOk = (typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0) || (typeof slot === 'bigint' && slot >= 0n);
  if (slot !== undefined && (!slotOk || BigInt(slot) > MAX_UINT64)) throw new Error(`ledger.currentSlot must be a non-negative integer slot number as number or bigint, got ${String(slot)}`);
  const drepRegistered = booleanOption('drepRegistered', false);
  const network = ledgerNetwork(options.network, networkId);
  return {
    state,
    checks: { params: resolveProtocolParams(networkId, options.protocolParams), currentSlot: slot === undefined ? undefined : BigInt(slot), drepRegistered, network },
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

  const ledger = ledgerOptions(options.ledger, networkId);
  if (ledger.chain) {
    for (const [key, why] of WALLET_OPTIONS_REPLACED_BY_CHAIN) if (options[key] !== undefined) throw new Error(`ledger.chain cannot be combined with ${why}`);
  }
  // With a chain the default of 10 ADA does not apply, the wallet holds what the chain holds.
  const utxos = ledger.chain ? [] : (options.utxos ?? [{ lovelace: 10_000_000 }]).map((u, i) => ({ lovelace: lovelaceString(u.lovelace), ...validateUtxoExtras(u, `utxos[${i}]`) }));
  checkOwnedSums(utxos);
  const submitFails = submitFailsProblem(options.quirks?.submitFails);
  if (submitFails) throw new Error(submitFails);

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
    // checks and chain only reach the page when set, so the page can warn when it has no host ledger. The chain options stay in Node.
    ledger: ledger.chain ? { state: true, chain: true } : ledger.checks ? { state: ledger.state, checks: true } : { state: ledger.state },
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
    ...(ledger.chain ? { chain: ledger.chain } : {}),
  };
}
