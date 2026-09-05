import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../src/core/bytes.js';
import { toBech32 } from '../src/core/addresses.js';
import { APIErrorCode } from '../src/core/errors.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { enableChw, testConfig } from './helpers/page.js';
import { EXPECTED_PAYMENT_ADDRESS, EXPECTED_REWARD_ADDRESS } from './fixtures/vectors.js';

describe('installWallet', () => {
  it('adds a CIP-30 provider under window.cardano.<name> without touching other entries', () => {
    const target: InstallTarget = { cardano: { other: { marker: true } } };
    installWallet(testConfig(), target);
    const cardano = target.cardano as Record<string, { apiVersion: string; name: string; icon: string; supportedExtensions: unknown[] }>;
    expect(cardano['other']).toEqual({ marker: true });
    expect(cardano['chw']!.apiVersion).toBe('1');
    expect(cardano['chw']!.name).toBe('Headless Wallet');
    expect(cardano['chw']!.icon).toBe('');
    expect(cardano['chw']!.supportedExtensions).toEqual([]);
  });

  it('creates window.cardano when it does not exist and exposes the control object', () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    expect(target.cardano).toBeDefined();
    expect(target.__chw).toBe(control);
    expect(control.journal).toEqual([]);
  });

  it('enable() returns an api object and isEnabled() flips to true', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig(), target);
    const provider = (target.cardano as Record<string, { enable: (o?: unknown) => Promise<unknown>; isEnabled: () => Promise<boolean> }>)['chw']!;
    expect(await provider.isEnabled()).toBe(false);
    const api = (await provider.enable({ extensions: [] })) as { getNetworkId: () => Promise<number> };
    expect(typeof api.getNetworkId).toBe('function');
    expect(await provider.isEnabled()).toBe(true);
  });

  it('answers network id, addresses in hex, and an empty extension list', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig(), target);
    const api = await enableChw(target);
    expect(await api.getNetworkId()).toBe(0);
    const change = await api.getChangeAddress();
    expect(change).toMatch(/^[0-9a-f]+$/);
    expect(toBech32(hexToBytes(change))).toBe(EXPECTED_PAYMENT_ADDRESS);
    expect(await api.getUsedAddresses()).toEqual([change]);
    expect(await api.getUnusedAddresses()).toEqual([]);
    const [reward] = await api.getRewardAddresses();
    expect(toBech32(hexToBytes(reward!))).toBe(EXPECTED_REWARD_ADDRESS);
    expect(await api.getExtensions()).toEqual([]);
  });

  it('reports the base address as unused when the wallet holds no utxo', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ utxos: [] }), target);
    const api = await enableChw(target);
    expect(await api.getUsedAddresses()).toEqual([]);
    expect(await api.getUnusedAddresses()).toEqual([await api.getChangeAddress()]);
  });

  it('builds mainnet addresses when networkId is 1, so address and network id never disagree', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ networkId: 1 }), target);
    const api = await enableChw(target);
    expect(await api.getNetworkId()).toBe(1);
    expect(toBech32(hexToBytes(await api.getChangeAddress())).startsWith('addr1')).toBe(true);
  });

  it('records every call in the journal with arguments and results', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const api = await enableChw(target);
    await api.getNetworkId();
    const methods = control.journal.map((e) => e.method);
    expect(methods).toEqual(['isEnabled', 'enable', 'getNetworkId']);
    expect(control.journal[2]!.result).toBe(0);
    expect(control.journal[1]!.args).toEqual([{ extensions: [] }]);
    expect(typeof control.journal[0]!.t).toBe('number');
  });

  it('rejects a config whose key hex has the wrong length with InvalidRequest', () => {
    const bad = testConfig();
    bad.keys.payment.hex = 'abcd';
    expect(() => installWallet(bad, {})).toThrow(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});
