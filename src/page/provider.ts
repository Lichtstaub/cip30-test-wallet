import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { decode } from '../core/cbor/decode.js';
import { encode } from '../core/cbor/encode.js';
import { parseTransaction, type ParsedTransaction } from '../core/cbor/tx.js';
import { signCose } from '../core/cose.js';
import { APIErrorCode, apiError, DataSignErrorCode, dataSignError, TxSignErrorCode, txSignError } from '../core/errors.js';
import type { SigningKey } from '../core/keys.js';
import { encodeUtxo, type MemoryLedger } from '../core/ledger.js';
import { parseAddressArg, parseHexArg, resolveDataSigner } from '../core/sign-data.js';
import { resolveInputs, signTx as coreSignTx, unsupportedForms } from '../core/sign-tx.js';
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
          const { coin: target, hasAssets } = parseValue(amount);
          // The wallet holds lovelace only, so any positive asset demand is unsatisfiable.
          if (hasAssets) return null;
          const picked = [];
          let sum = 0n;
          for (const u of utxos) {
            if (sum >= target) break;
            picked.push(u);
            sum += u.lovelace;
          }
          if (sum < target) return null;
          utxos = picked;
        }
        if (paginate !== undefined) utxos = paginateList(utxos, paginate);
        return utxos.map((u) => bytesToHex(encodeUtxo(u)));
      }),
    getBalance: () =>
      control.record('getBalance', [], async () => {
        const total = (await ledger.getWalletUtxos()).reduce((sum, u) => sum + u.lovelace, 0n);
        return bytesToHex(encode(total));
      }),
    signTx: (tx, partialSign = false) =>
      control.record('signTx', [tx, partialSign], async () => {
        if (typeof tx !== 'string') throw apiError(APIErrorCode.InvalidRequest, 'tx must be a hex string');
        // A string "false" is truthy and would switch the form check off.
        if (typeof partialSign !== 'boolean') throw apiError(APIErrorCode.InvalidRequest, 'partialSign must be a boolean');
        // Parsed once, before any prompt quirk: a real wallet refuses a
        // malformed transaction without ever showing it to the user.
        const parsed = parseTxArg(tx);
        if (partialSign) {
          try {
            const skipped = unsupportedForms(parsed.body, await resolveInputs(parsed.body, ledger));
            if (skipped.length > 0) {
              console.warn('[cip30-test-wallet] partialSign: true skipped unsupported transaction forms: ' + skipped.join(', '));
            }
          } catch {
            // A ledger failure is reported by coreSignTx below, not warned about here.
          }
        }
        if (control.quirks.signHangs) await control.wait('signTx');
        if (control.quirks.signRejected) throw txSignError(TxSignErrorCode.UserDeclined, 'user declined to sign the transaction');
        return coreSignTx(parsed, partialSign, { payment: ctx.payment, stake: ctx.stake, ledger });
      }),
    submitTx: (tx) =>
      control.record('submitTx', [tx], async () => {
        if (typeof tx !== 'string') throw apiError(APIErrorCode.InvalidRequest, 'tx must be a hex string');
        parseTxArg(tx);
        return bytesToHex(await ledger.submit(hexToBytes(tx)));
      }),
    signData: (addr, payload) => control.record('signData', [addr, payload], () => signDataWith(ctx, addr, payload, 'cip30')),
  };
  if (extensions.some((e) => e.cip === CIP95) && !control.quirks.cip95NamespaceMissing) api.cip95 = buildCip95Api(ctx);
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
 * validated. Asset quantities are only summarised, because this wallet
 * cannot hold assets yet, so a positive demand can never be covered. The
 * bounds below are enforced only so malformed input is caught early, assets
 * themselves are otherwise unsupported in this release.
 */
function parseValue(hex: string): { coin: bigint; hasAssets: boolean } {
  let value: unknown;
  try {
    value = decode(hexToBytes(hex));
  } catch {
    throw apiError(APIErrorCode.InvalidRequest, 'amount is not valid cbor');
  }
  if (typeof value === 'bigint' && value >= 0n) return { coin: value, hasAssets: false };
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'bigint' && value[0] >= 0n && value[1] instanceof Map) {
    let hasAssets = false;
    for (const [policy, assets] of value[1]) {
      if (!(policy instanceof Uint8Array) || policy.length !== 28) throw apiError(APIErrorCode.InvalidRequest, 'amount policy ids must be 28 bytes');
      if (!(assets instanceof Map)) throw apiError(APIErrorCode.InvalidRequest, 'amount multiasset must map policies to asset maps');
      for (const [name, quantity] of assets) {
        if (!(name instanceof Uint8Array) || name.length > 32) throw apiError(APIErrorCode.InvalidRequest, 'amount asset names must be at most 32 bytes');
        if (typeof quantity !== 'bigint' || quantity < 0n) throw apiError(APIErrorCode.InvalidRequest, 'amount asset quantities must be non-negative integers');
        if (quantity > 0n) hasAssets = true;
      }
    }
    return { coin: value[0], hasAssets };
  }
  throw apiError(APIErrorCode.InvalidRequest, 'amount must be a cbor value');
}

/** Hex to a parsed transaction, any failure as CIP-30 InvalidRequest with the reason. */
function parseTxArg(tx: string): ParsedTransaction {
  try {
    return parseTransaction(hexToBytes(tx));
  } catch (error) {
    throw apiError(APIErrorCode.InvalidRequest, error instanceof Error ? error.message : 'tx could not be decoded');
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
