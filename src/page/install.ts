import { blake2b } from '@noble/hashes/blake2.js';
import { assertNetwork, walletAddresses } from '../core/addresses.js';
import { hexToBytes } from '../core/bytes.js';
import { APIErrorCode, apiError } from '../core/errors.js';
import { keyHash } from '../core/hash.js';
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
 * object is available immediately so a test can observe the wait. With
 * answersEveryKey the namespace is replaced by a proxy over the same object.
 */
export function installWallet(config: PageConfig, target: InstallTarget): Control {
  const payment = toSigningKey(config.keys.payment, 'payment');
  const stake = toSigningKey(config.keys.stake, 'stake');
  const drep = toSigningKey(config.keys.drep, 'drep');
  const paymentPub = publicKey(payment);
  const stakePub = publicKey(stake);
  const drepPub = publicKey(drep);
  const { base: baseAddress, reward: rewardAddress } = walletAddresses(config.networkId, paymentPub, stakePub);
  assertNetwork(baseAddress, config.networkId);
  assertNetwork(rewardAddress, config.networkId);

  const control = new Control(config.quirks);
  const keys = { paymentPub, stakePub, drepPub, paymentHash: keyHash(paymentPub), stakeHash: keyHash(stakePub), drepHash: keyHash(drepPub) };
  const ctx: WalletContext = { config, control, ledger: buildLedger(config, baseAddress), payment, stake, drep, baseAddress, rewardAddress, keys };
  const provider = buildProvider(ctx);

  const define = () => {
    // Three shapes of window.cardano: absent (define a fresh writable property), an accessor
    // pair such as the doctor's access probe (assign through the setter so the probe keeps
    // observing), or a getter without setter (defineProperty replaces it). Never replace an
    // accessor pair, never clobber an existing value.
    if (!target.cardano) {
      const desc = Object.getOwnPropertyDescriptor(target, 'cardano');
      if (desc?.get && !desc.set) {
        Object.defineProperty(target, 'cardano', { value: {}, configurable: true, writable: true, enumerable: true });
      } else {
        target.cardano = {};
      }
    }
    (target.cardano as Record<string, unknown>)[config.name] = provider;
    if (config.quirks.answersEveryKey) target.cardano = answerEveryKey(target.cardano as Record<string, unknown>, provider);
  };
  const delay = config.quirks.lateInjection ?? 0;
  if (delay > 0) setTimeout(define, delay);
  else define();

  target.__chw = control;
  return control;
}

/**
 * The namespace shape of the VESPR iOS in-app browser: a proxy that returns
 * the wallet for any string key it does not hold. Keys it holds, inherited
 * members and symbols answer as before, so Object.keys, the in operator and
 * other wallets in the namespace are unaffected.
 */
function answerEveryKey(namespace: Record<string, unknown>, provider: unknown): Record<string, unknown> {
  return new Proxy(namespace, {
    get: (ns, key, receiver) => (typeof key === 'string' && !(key in ns) ? provider : Reflect.get(ns, key, receiver)),
  });
}
