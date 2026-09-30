import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { keyHash } from '../core/hash.js';
import type { MemoryLedger, Utxo } from '../core/ledger.js';
import { parseAddressArg } from '../core/sign-data.js';
import type { ForeignUtxoConfig } from '../page/config.js';
import { buildLedger } from '../page/install.js';
import type { PreparedWallet } from './config.js';

/** Name of the binding the page ledger calls in the Playwright fixture. */
export const LEDGER_BINDING = '__chwLedger';

/** A ledger UTxO in the JSON shape of walletOptions.foreignUtxos. */
export type LedgerUtxo = ForeignUtxoConfig;

export function utxoToConfig(u: Utxo): LedgerUtxo {
  const out: LedgerUtxo = { txId: bytesToHex(u.input.txId), index: Number(u.input.index), addressHex: bytesToHex(u.address), lovelace: u.lovelace.toString() };
  if (u.assets && u.assets.size > 0) {
    const units: Record<string, string> = {};
    for (const [policy, names] of u.assets) for (const [name, quantity] of names) units[policy + name] = quantity.toString();
    out.assets = units;
  }
  if (u.datum?.kind === 'hash') out.datumHash = bytesToHex(u.datum.hash);
  if (u.datum?.kind === 'inline') out.inlineDatum = bytesToHex(u.datum.cbor);
  if (u.scriptRef) out.scriptRef = bytesToHex(u.scriptRef);
  return out;
}

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
