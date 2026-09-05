import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { decode } from '../core/cbor/decode.js';
import { encode } from '../core/cbor/encode.js';
import { APIErrorCode, apiError, TxSignErrorCode, txSignError } from '../core/errors.js';
import type { SigningKey } from '../core/keys.js';
import { encodeUtxo, type MemoryLedger } from '../core/ledger.js';
import { signTx as coreSignTx } from '../core/sign-tx.js';
import type { Control } from './control.js';
import type { PageConfig } from './config.js';

export interface WalletContext {
  config: PageConfig;
  control: Control;
  ledger: MemoryLedger;
  payment: SigningKey;
  stake: SigningKey;
  baseAddress: Uint8Array;
  rewardAddress: Uint8Array;
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
}

export interface Cip30Provider {
  apiVersion: string;
  name: string;
  icon: string;
  supportedExtensions: { cip: number }[];
  isEnabled(): Promise<boolean>;
  enable(options?: { extensions?: { cip: number }[] }): Promise<Cip30Api>;
}

/** Builds the injected provider. Task 2 adds getUtxos, getBalance, signTx and submitTx to buildApi. */
export function buildProvider(ctx: WalletContext): Cip30Provider {
  const { control, config } = ctx;
  let enabled = false;
  const api = buildApi(ctx);

  return {
    apiVersion: '1',
    name: config.displayName,
    icon: config.icon,
    supportedExtensions: [],
    isEnabled: () => control.record('isEnabled', [], async () => enabled),
    enable: (options) =>
      control.record('enable', [options ?? {}], async () => {
        if (control.quirks.enableRejected) throw apiError(APIErrorCode.Refused, 'user declined to connect the wallet');
        enabled = true;
        return api;
      }),
  };
}

export function buildApi(ctx: WalletContext): Cip30Api {
  const { control, config, ledger } = ctx;
  const baseHex = bytesToHex(ctx.baseAddress);
  const rewardHex = bytesToHex(ctx.rewardAddress);
  const hasFunds = async () => (await ledger.getWalletUtxos()).length > 0;

  return {
    getNetworkId: () => control.record('getNetworkId', [], async () => config.networkId),
    getUsedAddresses: (paginate) => control.record('getUsedAddresses', [paginate], async () => ((await hasFunds()) ? [baseHex] : [])),
    getUnusedAddresses: () => control.record('getUnusedAddresses', [], async () => ((await hasFunds()) ? [] : [baseHex])),
    getChangeAddress: () => control.record('getChangeAddress', [], async () => baseHex),
    getRewardAddresses: () => control.record('getRewardAddresses', [], async () => [rewardHex]),
    getExtensions: () => control.record('getExtensions', [], async () => []),
    getUtxos: (amount, paginate) =>
      control.record('getUtxos', [amount, paginate], async () => {
        let utxos = await ledger.getWalletUtxos();
        if (amount !== undefined) {
          const target = lovelaceOfValue(amount);
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
        requireHex(tx, 'tx');
        if (control.quirks.signHangs) await control.wait('signTx');
        if (control.quirks.signRejected) throw txSignError(TxSignErrorCode.UserDeclined, 'user declined to sign the transaction');
        return coreSignTx(tx, partialSign, { payment: ctx.payment, stake: ctx.stake, ledger });
      }),
    submitTx: (tx) =>
      control.record('submitTx', [tx], async () => {
        requireHex(tx, 'tx');
        return bytesToHex(await ledger.submit(hexToBytes(tx)));
      }),
  };
}

function requireHex(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw apiError(APIErrorCode.InvalidRequest, `${what} must be an even-length hex string`);
  }
}

/** cbor<value> is either a uint (coin) or [coin, multiasset]. Assets are ignored in this milestone. */
function lovelaceOfValue(hex: string): bigint {
  requireHex(hex, 'amount');
  let value: unknown;
  try {
    value = decode(hexToBytes(hex));
  } catch {
    throw apiError(APIErrorCode.InvalidRequest, 'amount is not valid cbor');
  }
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Array.isArray(value) && typeof value[0] === 'bigint' && value[0] >= 0n) return value[0];
  throw apiError(APIErrorCode.InvalidRequest, 'amount must be a cbor value');
}

function paginateList<T>(items: T[], paginate: { page: number; limit: number }): T[] {
  const { page, limit } = paginate;
  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 0 || limit <= 0) {
    throw apiError(APIErrorCode.InvalidRequest, 'paginate needs a non-negative integer page and a positive integer limit');
  }
  const maxSize = Math.max(1, Math.ceil(items.length / limit));
  if (page >= maxSize) throw { maxSize };
  return items.slice(page * limit, page * limit + limit);
}
