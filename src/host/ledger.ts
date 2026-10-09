import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { ChwError, isCip30Error } from '../core/errors.js';
import { keyHash } from '../core/hash.js';
import type { Ledger } from '../core/ledger.js';
import { parseAddressArg } from '../core/sign-data.js';
import type { LedgerAnswer } from '../page/binding-ledger.js';
import { buildLedger } from '../page/install.js';
import { utxoToConfig } from '../page/utxo-config.js';
import { CheckedLedger } from './checks/checked-ledger.js';
import type { PreparedWallet } from './config.js';

/** Name of the binding the page ledger calls in the Playwright fixture. */
export const LEDGER_BINDING = '__chwLedger';

/**
 * The wallet's ledger for one test, kept in Node so it outlives reloads and
 * origin changes. With ledger.checks it refuses what a node would refuse.
 */
export function walletLedger(prepared: PreparedWallet): Ledger {
  const stakeKeyHash = keyHash(hexToBytes(prepared.stakePublicKeyHex));
  const memory = buildLedger(prepared.config, {
    baseAddress: parseAddressArg(prepared.addresses.payment),
    paymentKeyHash: keyHash(hexToBytes(prepared.paymentPublicKeyHex)),
    stakeKeyHash,
  });
  if (!prepared.ledgerChecks) return memory;
  return new CheckedLedger(memory, {
    checks: prepared.ledgerChecks,
    networkId: prepared.config.networkId,
    stakeKeyHash,
    drepKeyHash: hexToBytes(prepared.drepKeyHashHex),
    stakeRegistered: prepared.config.stakeRegistered,
  });
}

/**
 * Runs one ledger operation and turns the two error kinds the page knows into values, since a
 * thrown value reaches the page without its code. Anything else is a bug in the host and is
 * thrown as it is.
 */
async function answer<T>(run: () => Promise<T>): Promise<LedgerAnswer<T>> {
  try {
    return { value: await run() };
  } catch (e) {
    if (isCip30Error(e)) return { error: { code: e.code, info: e.info } };
    if (e instanceof ChwError) {
      // The page rebuilds the ChwError, which puts the code in front of the message again.
      const prefix = `${e.code}: `;
      return { chwError: { code: e.code, message: e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message } };
    }
    throw e;
  }
}

/** The host side of the binding: one operation name and a JSON argument, answered in JSON. */
export function ledgerBinding(ledger: Ledger) {
  return async (_source: unknown, op: string, arg?: unknown): Promise<unknown> => {
    switch (op) {
      case 'resolveInput': {
        const { txId, index } = arg as { txId: string; index: string };
        return answer(async () => {
          const found = await ledger.resolveInput({ txId: hexToBytes(txId), index: BigInt(index) });
          return found ? utxoToConfig(found) : null;
        });
      }
      case 'getWalletUtxos':
        return answer(async () => (await ledger.getWalletUtxos()).map(utxoToConfig));
      case 'getStakeRegistered':
        return answer(() => ledger.getStakeRegistered());
      case 'submit':
        return answer(async () => bytesToHex(await ledger.submit(hexToBytes(arg as string))));
      default:
        throw new Error(`unknown ledger operation ${op}`);
    }
  };
}
