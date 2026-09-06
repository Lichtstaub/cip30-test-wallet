import { blake2b } from '@noble/hashes/blake2.js';
import { assertNetwork, walletAddresses } from '../core/addresses.js';
import { hexToBytes } from '../core/bytes.js';
import { APIErrorCode, apiError } from '../core/errors.js';
import { publicKey, type SigningKey } from '../core/keys.js';
import { MemoryLedger, type Utxo } from '../core/ledger.js';
import type { KeyConfig, PageConfig } from './config.js';
import { Control } from './control.js';
import { buildProvider, type WalletContext } from './provider.js';

export interface InstallTarget {
  cardano?: Record<string, unknown>;
  __chw?: Control;
}

function toSigningKey(k: KeyConfig, what: string): SigningKey {
  const want = k.kind === 'seed' ? 32 : 64;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(k.hex);
  } catch {
    throw apiError(APIErrorCode.InvalidRequest, `${what} key is not valid hex`);
  }
  if (bytes.length !== want) throw apiError(APIErrorCode.InvalidRequest, `${what} key must be ${want} bytes`);
  return { kind: k.kind, bytes };
}

/**
 * Deterministic outpoint for a configured wallet utxo. The id depends only
 * on the wallet name and the position, so a demo can embed a transaction
 * that spends utxo 0 of the default wallet and it will resolve every run.
 */
export function syntheticOwnedUtxo(name: string, index: number, address: Uint8Array, lovelace: bigint): Utxo {
  const txId = blake2b(new TextEncoder().encode(`chw:${name}:${index}`), { dkLen: 32 });
  return { input: { txId, index: 0n }, address, lovelace };
}

export function buildLedger(config: PageConfig, address: Uint8Array): MemoryLedger {
  const owned = config.utxos.map((u, i) => syntheticOwnedUtxo(config.name, i, address, BigInt(u.lovelace)));
  const foreign = config.foreignUtxos.map((f) => ({
    input: { txId: hexToBytes(f.txId), index: BigInt(f.index) },
    address: hexToBytes(f.addressHex),
    lovelace: BigInt(f.lovelace),
  }));
  return new MemoryLedger({ owned, foreign });
}

/**
 * Installs the provider into the target (window in the page, any object in
 * tests). Existing entries in target.cardano stay untouched. With the
 * lateInjection quirk the provider appears after the delay, the control
 * object is available immediately so a test can observe the wait.
 */
export function installWallet(config: PageConfig, target: InstallTarget): Control {
  const payment = toSigningKey(config.keys.payment, 'payment');
  const stake = toSigningKey(config.keys.stake, 'stake');
  const { base: baseAddress, reward: rewardAddress } = walletAddresses(config.networkId, publicKey(payment), publicKey(stake));
  assertNetwork(baseAddress, config.networkId);
  assertNetwork(rewardAddress, config.networkId);

  const control = new Control(config.quirks);
  const ctx: WalletContext = { config, control, ledger: buildLedger(config, baseAddress), payment, stake, baseAddress, rewardAddress };
  const provider = buildProvider(ctx);

  const define = () => {
    // A plain target.cardano = {} throws when a page defines window.cardano as a getter
    // without a setter. defineProperty always succeeds and leaves a fresh, writable property
    // so the init script survives either way.
    if (!target.cardano) {
      Object.defineProperty(target, 'cardano', { value: {}, configurable: true, writable: true, enumerable: true });
    }
    (target.cardano as Record<string, unknown>)[config.name] = provider;
  };
  const delay = config.quirks.lateInjection ?? 0;
  if (delay > 0) setTimeout(define, delay);
  else define();

  target.__chw = control;
  return control;
}
