import { describe, expect, it } from 'vitest';
import { enterpriseAddressBytes } from '../src/core/addresses.js';
import { hexToBytes } from '../src/core/bytes.js';
import { ChwError } from '../src/core/errors.js';
import { keyHash } from '../src/core/hash.js';
import type { Utxo, WalletCredentials } from '../src/core/ledger.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { chainProvider, connectChain } from '../src/host/chain/index.js';
import { prepareWallet, type WalletOptions } from '../src/host/config.js';
import { chainLedger } from '../src/host/ledger.js';
import { FakeChain } from './helpers/fake-chain.js';
import { rejectionOf } from './helpers/page.js';
import { syntheticInput } from './helpers/synthetic.js';

const OGMIOS = { provider: 'ogmios', url: 'http://localhost:1337' } as const;

function walletOf(options: WalletOptions) {
  const prepared = prepareWallet(options);
  const wallet: WalletCredentials = {
    paymentKeyHash: keyHash(hexToBytes(prepared.paymentPublicKeyHex)),
    stakeKeyHash: keyHash(hexToBytes(prepared.stakePublicKeyHex)),
    networkId: prepared.config.networkId,
  };
  return { prepared, wallet };
}

describe('chainProvider', () => {
  it('builds the client the options name', () => {
    expect(chainProvider(OGMIOS).name).toBe('ogmios');
    expect(chainProvider({ provider: 'koios', network: 'preprod' }).name).toBe('koios');
  });
});

describe('chainLedger', () => {
  it('reads the prepared wallet\'s base address with its key hashes', async () => {
    const { prepared, wallet } = walletOf({ ledger: { chain: OGMIOS } });
    const base: Utxo = { input: syntheticInput('wiring-base', 0n), address: parseAddressArg(prepared.addresses.payment), lovelace: 7_000_000n };
    const enterprise: Utxo = { input: syntheticInput('wiring-enterprise', 0n), address: enterpriseAddressBytes(0, wallet.paymentKeyHash), lovelace: 1_000_000n };
    const chain = new FakeChain({ wallet, owned: [base, enterprise], stakeRegistered: true });
    const ledger = chainLedger(prepared, chain);
    expect(await ledger.getWalletUtxos()).toEqual([base]);
    expect(await ledger.getStakeRegistered()).toBe(true);
  });
});

describe('connectChain', () => {
  it.each([
    [0, undefined, false],
    [0, true, false],
    [1, undefined, true],
    [1, false, true],
    [1, true, false],
  ] as const)('networkId %s with allowMainnetSigning %s locks signTx: %s', async (networkId, allow, locked) => {
    const { prepared, wallet } = walletOf({ networkId, ledger: { chain: { ...OGMIOS, ...(allow === undefined ? {} : { allowMainnetSigning: allow }) } } });
    const connected = await connectChain(prepared, new FakeChain({ wallet, networkId }));
    expect(connected.signLocked).toBe(locked);
    expect(await connected.ledger.pendingTxIds()).toEqual([]);
  });

  it.each([
    [0, 1, 'ledger.chain: fake reports mainnet (networkId 1), walletOptions.networkId is 0'],
    [1, 0, 'ledger.chain: fake reports a test network (networkId 0), walletOptions.networkId is 1'],
  ] as const)('refuses walletOptions.networkId %s on a chain with networkId %s', async (networkId, chainNetworkId, message) => {
    const { prepared, wallet } = walletOf({ networkId, ledger: { chain: OGMIOS } });
    await expect(connectChain(prepared, new FakeChain({ wallet, networkId: chainNetworkId }))).rejects.toThrow(message);
  });

  it('passes a transport failure of the network query on as it is', async () => {
    const { prepared, wallet } = walletOf({ ledger: { chain: OGMIOS } });
    const chain = new FakeChain({ wallet });
    chain.failNext('networkId');
    const e = await rejectionOf(connectChain(prepared, chain));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: fake networkId failed with HTTP 503' });
  });
});
