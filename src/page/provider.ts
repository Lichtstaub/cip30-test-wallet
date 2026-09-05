import { bytesToHex } from '../core/bytes.js';
import { APIErrorCode, apiError } from '../core/errors.js';
import type { SigningKey } from '../core/keys.js';
import type { MemoryLedger } from '../core/ledger.js';
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
    getUtxos: () => control.record('getUtxos', [], async () => { throw apiError(APIErrorCode.InternalError, 'getUtxos arrives with task 2'); }),
    getBalance: () => control.record('getBalance', [], async () => { throw apiError(APIErrorCode.InternalError, 'getBalance arrives with task 2'); }),
    signTx: () => control.record('signTx', [], async () => { throw apiError(APIErrorCode.InternalError, 'signTx arrives with task 2'); }),
    submitTx: () => control.record('submitTx', [], async () => { throw apiError(APIErrorCode.InternalError, 'submitTx arrives with task 2'); }),
  };
}
