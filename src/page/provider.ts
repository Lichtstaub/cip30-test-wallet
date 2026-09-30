import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { decode, type CborValue } from '../core/cbor/decode.js';
import { encode } from '../core/cbor/encode.js';
import { signCose } from '../core/cose.js';
import { APIErrorCode, apiError, DataSignErrorCode, dataSignError, TxSignErrorCode, txSignError } from '../core/errors.js';
import type { SigningKey } from '../core/keys.js';
import { encodeUtxo, type MemoryLedger } from '../core/ledger.js';
import { parseAddressArg, parseHexArg, resolveDataSigner } from '../core/sign-data.js';
import { requirements } from '../core/requirements.js';
import { parseTxHex, refuseDeprecatedCertificate, resolveInputs, signTx as coreSignTx } from '../core/sign-tx.js';
import { selectCollateral, selectForAmount } from '../core/select.js';
import { addAssets, valueCbor, valueFromCbor, type MultiAsset } from '../core/value.js';
import type { Control } from './control.js';
import type { PageConfig } from './config.js';

/** The payment, stake and DRep public keys and their key hashes, derived once at install time. */
export interface WalletKeys {
  paymentPub: Uint8Array;
  stakePub: Uint8Array;
  drepPub: Uint8Array;
  paymentHash: Uint8Array;
  stakeHash: Uint8Array;
  drepHash: Uint8Array;
}

export interface WalletContext {
  config: PageConfig;
  control: Control;
  ledger: MemoryLedger;
  payment: SigningKey;
  stake: SigningKey;
  drep: SigningKey;
  baseAddress: Uint8Array;
  rewardAddress: Uint8Array;
  keys: WalletKeys;
}

export interface DataSignature {
  signature: string;
  key: string;
}

export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUtxos(amount?: string, paginate?: { page: number; limit: number }): Promise<string[] | null>;
  getBalance(): Promise<string>;
  getUsedAddresses(paginate?: { page: number; limit: number }): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  getExtensions(): Promise<{ cip: number }[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
  signData(addr: string, payload: string): Promise<DataSignature>;
  getCollateral?(params?: { amount?: string | number | bigint }): Promise<string[] | null>;
  experimental?: { getCollateral(params?: { amount?: string | number | bigint }): Promise<string[] | null> };
  cip95?: Cip95Api;
}

export interface Cip95Api {
  getPubDRepKey(): Promise<string>;
  getRegisteredPubStakeKeys(): Promise<string[]>;
  getUnregisteredPubStakeKeys(): Promise<string[]>;
  signData(addr: string, payload: string): Promise<DataSignature>;
}

export interface Cip30Provider {
  apiVersion: string;
  name: string;
  icon: string;
  supportedExtensions: { cip: number }[];
  isEnabled(): Promise<boolean>;
  enable(options?: { extensions?: { cip: number }[] }): Promise<Cip30Api>;
}

const CIP95 = 95;

function availableExtensions(control: Control): { cip: number }[] {
  return control.quirks.noCip95 ? [] : [{ cip: CIP95 }];
}

/** Builds the injected provider. */
export function buildProvider(ctx: WalletContext): Cip30Provider {
  const { control, config } = ctx;
  let enabled = false;

  return {
    apiVersion: '1',
    name: config.displayName,
    icon: config.icon,
    // A getter, so a quirk set at runtime changes what a dApp reads next.
    get supportedExtensions() {
      return availableExtensions(control);
    },
    isEnabled: () => control.record('isEnabled', [], async () => enabled),
    enable: (options) =>
      control.record('enable', [options], async () => {
        const requested = requestedExtensions(options);
        if (control.quirks.enableRejected) throw apiError(APIErrorCode.Refused, 'user declined to connect the wallet');
        enabled = true;
        const granted = availableExtensions(control).filter((s) => requested.some((r) => r.cip === s.cip));
        return buildApi(ctx, granted);
      }),
  };
}

/** CIP-30 caps collateral at about 5 ADA ("something like 5 ADA"), Lace uses exactly this. */
const MAX_COLLATERAL = 5_000_000n;

/**
 * getCollateral({ amount }). No argument or no amount means 5 ADA, the way
 * Mesh calls it and Lace answers it. amount is CBOR hex of a coin (a string
 * is always CBOR, never a decimal), or a number or bigint. A bare value
 * instead of the object, anything else, or more than 5 ADA is InvalidRequest.
 */
function collateralAmount(params: unknown): bigint {
  if (params === undefined) return MAX_COLLATERAL;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw apiError(APIErrorCode.InvalidRequest, 'getCollateral takes an object { amount }');
  }
  const amount = (params as { amount?: unknown }).amount;
  if (amount === undefined) return MAX_COLLATERAL;
  let value: bigint;
  if (typeof amount === 'bigint') value = amount;
  else if (typeof amount === 'number' && Number.isSafeInteger(amount)) value = BigInt(amount);
  else if (typeof amount === 'string') {
    let decoded: unknown;
    try {
      decoded = decode(hexToBytes(amount));
    } catch {
      throw apiError(APIErrorCode.InvalidRequest, 'amount is not valid cbor');
    }
    if (typeof decoded !== 'bigint') throw apiError(APIErrorCode.InvalidRequest, 'amount must be the cbor of a coin');
    value = decoded;
  } else throw apiError(APIErrorCode.InvalidRequest, 'amount must be cbor hex, a number or a bigint');
  // CIP-30 returns "one or more UTXOs", a zero amount would ask for none.
  if (value <= 0n) throw apiError(APIErrorCode.InvalidRequest, 'amount must be positive');
  if (value > MAX_COLLATERAL) throw apiError(APIErrorCode.InvalidRequest, 'amount is above the 5 ADA collateral limit');
  return value;
}

export function buildApi(ctx: WalletContext, extensions: { cip: number }[] = []): Cip30Api {
  const { control, config, ledger } = ctx;
  const baseHex = bytesToHex(ctx.baseAddress);
  const rewardHex = bytesToHex(ctx.rewardAddress);
  const hasFunds = async () => (await ledger.getWalletUtxos()).length > 0;

  const api: Cip30Api = {
    getNetworkId: () => control.record('getNetworkId', [], async () => config.networkId),
    getUsedAddresses: (paginate) =>
      control.record('getUsedAddresses', [paginate], async () => {
        const used = (await hasFunds()) ? [baseHex] : [];
        return paginate === undefined ? used : paginateList(used, paginate);
      }),
    getUnusedAddresses: () => control.record('getUnusedAddresses', [], async () => ((await hasFunds()) ? [] : [baseHex])),
    getChangeAddress: () => control.record('getChangeAddress', [], async () => baseHex),
    getRewardAddresses: () => control.record('getRewardAddresses', [], async () => [rewardHex]),
    getExtensions: () => control.record('getExtensions', [], async () => extensions.map((e) => ({ ...e }))),
    getUtxos: (amount, paginate) =>
      control.record('getUtxos', [amount, paginate], async () => {
        let utxos = await ledger.getWalletUtxos();
        if (amount !== undefined) {
          const { coin, assets } = parseValue(amount);
          const selected = selectForAmount(utxos, coin, assets);
          if (selected === null) return null;
          utxos = selected;
        }
        if (paginate !== undefined) utxos = paginateList(utxos, paginate);
        return utxos.map((u) => bytesToHex(encodeUtxo(u)));
      }),
    getBalance: () =>
      control.record('getBalance', [], async () => {
        const utxos = await ledger.getWalletUtxos();
        const coin = utxos.reduce((sum, u) => sum + u.lovelace, 0n);
        const assets: MultiAsset = new Map();
        for (const u of utxos) addAssets(assets, u.assets);
        return bytesToHex(encode(valueCbor(coin, assets)));
      }),
    signTx: (tx, partialSign = false) =>
      control.record('signTx', [tx, partialSign], async () => {
        // A string "false" is truthy and would switch the form check off.
        if (typeof partialSign !== 'boolean') throw apiError(APIErrorCode.InvalidRequest, 'partialSign must be a boolean');
        // Parsed once, before any prompt quirk: a real wallet refuses a
        // malformed transaction without ever showing it to the user.
        const { parsed } = parseTxHex(tx);
        // CIP-95: refused regardless of user consent, so before any prompt quirk and at both partialSign values.
        refuseDeprecatedCertificate(parsed.body);
        // Validates every governance field before any prompt quirk. No ledger needed, unresolved inputs are skipped.
        requirements(parsed.body, []);
        if (partialSign) {
          try {
            const skipped = requirements(parsed.body, await resolveInputs(parsed.body, ledger)).unsupported;
            if (skipped.length > 0) {
              console.warn('[cip30-test-wallet] partialSign: true skipped unsupported transaction forms: ' + skipped.join(', '));
            }
          } catch {
            // A ledger failure is reported by coreSignTx below, not warned about here.
          }
        }
        if (control.quirks.signHangs) await control.wait('signTx');
        if (control.quirks.signRejected) throw txSignError(TxSignErrorCode.UserDeclined, 'user declined to sign the transaction');
        // A wallet without CIP-95 has no DRep key, its DRep requirements are foreign.
        const drep = control.quirks.noCip95 ? {} : { drep: ctx.drep };
        return coreSignTx(parsed, partialSign, { payment: ctx.payment, stake: ctx.stake, ...drep, ledger });
      }),
    submitTx: (tx) =>
      control.record('submitTx', [tx], async () => {
        const { bytes } = parseTxHex(tx);
        return bytesToHex(await ledger.submit(bytes));
      }),
    signData: (addr, payload) => control.record('signData', [addr, payload], () => signDataWith(ctx, addr, payload, 'cip30')),
  };
  if (extensions.some((e) => e.cip === CIP95) && !control.quirks.cip95NamespaceMissing) api.cip95 = buildCip95Api(ctx);
  if (!control.quirks.noCollateral) {
    const collateral = (method: string) => (params?: unknown) =>
      control.record(method, [params], async () => {
        const amount = collateralAmount(params);
        const selected = selectCollateral(await ledger.getWalletUtxos(), amount);
        return selected === null ? null : selected.map((u) => bytesToHex(encodeUtxo(u)));
      });
    api.getCollateral = collateral('getCollateral');
    api.experimental = { getCollateral: collateral('experimental.getCollateral') };
  }
  return api;
}

function buildCip95Api(ctx: WalletContext): Cip95Api {
  const { control, config } = ctx;
  const stakeHex = bytesToHex(ctx.keys.stakePub);
  // CIP-95: these endpoints take no parameters, passing one is InvalidRequest.
  // An explicit undefined counts as absent, wrappers often forward optional
  // arguments that way and real wallets ignore them.
  const noArgs =
    <T>(method: string, run: () => Promise<T>) =>
    (...args: unknown[]) =>
      control.record(`cip95.${method}`, args, async () => {
        if (args.some((a) => a !== undefined)) throw apiError(APIErrorCode.InvalidRequest, `${method} takes no parameters`);
        return run();
      });
  return {
    getPubDRepKey: noArgs('getPubDRepKey', async () => bytesToHex(ctx.keys.drepPub)),
    getRegisteredPubStakeKeys: noArgs('getRegisteredPubStakeKeys', async () => (config.stakeRegistered ? [stakeHex] : [])),
    getUnregisteredPubStakeKeys: noArgs('getUnregisteredPubStakeKeys', async () => (config.stakeRegistered ? [] : [stakeHex])),
    signData: (addr, payload) => control.record('cip95.signData', [addr, payload], () => signDataWith(ctx, addr, payload, 'cip95')),
  };
}

/** Shared by signData and cip95.signData. Validation first, like a real wallet, then the prompt quirks, then the signature. */
export async function signDataWith(ctx: WalletContext, addr: unknown, payload: unknown, mode: 'cip30' | 'cip95'): Promise<DataSignature> {
  const addressBytes = parseAddressArg(addr);
  const payloadBytes = parseHexArg(payload, 'payload');
  const signer = resolveDataSigner(addressBytes, { networkId: ctx.config.networkId, payment: ctx.payment, stake: ctx.stake, drep: ctx.drep, ...ctx.keys }, mode);
  let headerAddress = signer.headerAddress;
  if (signer.role === 'drep') {
    const form = ctx.control.quirks.cip95SignData;
    // Reported for VESPR: the type 6 form fails as if the user had declined.
    if (form === 'bareOnly' && signer.drepForm === 'type6') throw dataSignError(DataSignErrorCode.UserDeclined, 'user declined to sign the data');
    if (form === 'type6Only' && signer.drepForm === 'bare') throw dataSignError(DataSignErrorCode.ProofGeneration, 'the wallet cannot sign for a bare DRep ID');
    if (ctx.control.quirks.coseAddress === 'bareKeyHash') headerAddress = ctx.keys.drepHash;
  }
  if (ctx.control.quirks.signDataRejected) throw dataSignError(DataSignErrorCode.UserDeclined, 'user declined to sign the data');
  const { signature, key } = signCose(signer.key, headerAddress, payloadBytes, signer.publicKey);
  return { signature: bytesToHex(signature), key: bytesToHex(key) };
}

/**
 * cbor<value> is either a uint (coin) or [coin, multiasset] with
 * multiasset = { policy_id => { asset_name => quantity } }. The structure is
 * validated. Positive asset quantities are returned keyed by hex policy
 * and asset name, to be matched against the wallet's UTxOs.
 */
function parseValue(hex: string): { coin: bigint; assets: MultiAsset } {
  let value: unknown;
  try {
    value = decode(hexToBytes(hex));
  } catch {
    throw apiError(APIErrorCode.InvalidRequest, 'amount is not valid cbor');
  }
  try {
    return valueFromCbor(value as CborValue, 'amount');
  } catch (error) {
    throw apiError(APIErrorCode.InvalidRequest, error instanceof Error ? error.message : 'amount must be a cbor value');
  }
}

/**
 * CIP-30 enable({ extensions: [{ cip: number }] }). No options, an empty
 * object and an unsupported CIP number are fine. A malformed shape is
 * InvalidRequest, so a dApp that sends one does not connect silently without
 * the extensions it meant to ask for.
 */
function requestedExtensions(options: unknown): Array<{ cip: number }> {
  if (options === undefined || options === null) return [];
  if (typeof options !== 'object' || Array.isArray(options)) throw apiError(APIErrorCode.InvalidRequest, 'enable options must be an object');
  const extensions = (options as { extensions?: unknown }).extensions;
  if (extensions === undefined) return [];
  // Array.from visits holes too, every() would skip them.
  const isExtension = (e: unknown) => typeof e === 'object' && e !== null && Number.isInteger((e as { cip?: unknown }).cip);
  if (!Array.isArray(extensions) || !Array.from(extensions).every(isExtension)) {
    throw apiError(APIErrorCode.InvalidRequest, 'enable extensions must be an array of { cip: number }');
  }
  return extensions as Array<{ cip: number }>;
}

function paginateList<T>(items: T[], paginate: { page: number; limit: number }): T[] {
  if (typeof paginate !== 'object' || paginate === null) {
    throw apiError(APIErrorCode.InvalidRequest, 'paginate must be an object with page and limit');
  }
  const { page, limit } = paginate;
  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 0 || limit <= 0) {
    throw apiError(APIErrorCode.InvalidRequest, 'paginate needs a non-negative integer page and a positive integer limit');
  }
  const maxSize = Math.max(1, Math.ceil(items.length / limit));
  if (page >= maxSize) throw { maxSize };
  return items.slice(page * limit, page * limit + limit);
}
