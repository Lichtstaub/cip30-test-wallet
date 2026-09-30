import { bytesToHex, hexToBytes } from '../core/bytes.js';
import { APIErrorCode, apiError } from '../core/errors.js';
import type { Utxo } from '../core/ledger.js';
import { parseAssetUnits } from '../core/value.js';
import type { ForeignUtxoConfig, UtxoExtras } from './config.js';

/** The optional output parts of a configured UTxO, turned from JSON into ledger values. */
export function parseUtxoExtras(c: UtxoExtras): Pick<Utxo, 'assets' | 'datum' | 'scriptRef'> {
  const out: Pick<Utxo, 'assets' | 'datum' | 'scriptRef'> = {};
  // A hand-written PageConfig that skips the Node checks fails at install with a CIP-30 error.
  try {
    if (c.assets) out.assets = parseAssetUnits(c.assets);
    if (c.datumHash) out.datum = { kind: 'hash', hash: hexToBytes(c.datumHash) };
    if (c.inlineDatum) out.datum = { kind: 'inline', cbor: hexToBytes(c.inlineDatum) };
    if (c.scriptRef) out.scriptRef = hexToBytes(c.scriptRef);
  } catch (error) {
    throw apiError(APIErrorCode.InvalidRequest, error instanceof Error ? error.message : 'invalid utxo value');
  }
  return out;
}

/** A UTxO in the JSON shape of walletOptions.foreignUtxos, as the ledger holds it. */
export function utxoFromConfig(f: ForeignUtxoConfig): Utxo {
  return { input: { txId: hexToBytes(f.txId), index: BigInt(f.index) }, address: hexToBytes(f.addressHex), lovelace: BigInt(f.lovelace), ...parseUtxoExtras(f) };
}

/** A ledger UTxO in the JSON shape of walletOptions.foreignUtxos. */
export type LedgerUtxo = ForeignUtxoConfig;

/** The other direction of utxoFromConfig, for the binding and for wallet.utxos(). */
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
