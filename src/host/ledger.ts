import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { keyHash } from '../core/hash.js';
import type { MemoryLedger } from '../core/ledger.js';
import { parseAddressArg } from '../core/sign-data.js';
import { buildLedger } from '../page/install.js';
import { utxoToConfig } from '../page/utxo-config.js';
import type { PreparedWallet } from './config.js';

/** Name of the binding the page ledger calls in the Playwright fixture. */
export const LEDGER_BINDING = '__chwLedger';

/** The wallet's ledger for one test, kept in Node so it outlives reloads and origin changes. */
export function walletLedger(prepared: PreparedWallet): MemoryLedger {
  return buildLedger(prepared.config, {
    baseAddress: parseAddressArg(prepared.addresses.payment),
    paymentKeyHash: keyHash(hexToBytes(prepared.paymentPublicKeyHex)),
    stakeKeyHash: keyHash(hexToBytes(prepared.stakePublicKeyHex)),
  });
}

/** The host side of the binding: one operation name and a JSON argument, answered in JSON. */
export function ledgerBinding(ledger: MemoryLedger) {
  return async (_source: unknown, op: string, arg?: unknown): Promise<unknown> => {
    switch (op) {
      case 'resolveInput': {
        const { txId, index } = arg as { txId: string; index: string };
        const found = await ledger.resolveInput({ txId: hexToBytes(txId), index: BigInt(index) });
        return found ? utxoToConfig(found) : null;
      }
      case 'getWalletUtxos':
        return (await ledger.getWalletUtxos()).map(utxoToConfig);
      case 'getStakeRegistered':
        return ledger.getStakeRegistered();
      case 'submit':
        return bytesToHex(await ledger.submit(hexToBytes(arg as string)));
      default:
        throw new Error(`unknown ledger operation ${op}`);
    }
  };
}
