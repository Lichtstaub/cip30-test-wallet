import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChwError } from '../src/core/errors.js';
import { LEDGER_BINDING } from '../src/host/ledger.js';
import type { PageConfig } from '../src/page/config.js';
import { attachWallet } from '../src/playwright/index.js';
import { rejectionOf } from './helpers/page.js';

// The init script as only the call that installs the config, so these tests read what the page
// receives without a built page bundle. initScript itself is tested in ledger-options.test.ts.
vi.mock('../src/host/bundle.js', () => ({ initScript: (config: unknown) => `__chwInit(${JSON.stringify(config)});` }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OGMIOS = { provider: 'ogmios', url: 'http://localhost:1337' } as const;

/** The two Page methods attachWallet uses, recording what it registers. */
function fakePage() {
  const scripts: string[] = [];
  const exposeBinding = vi.fn(async (_name: string, _callback: unknown) => undefined);
  const addInitScript = vi.fn(async (script: { content: string }) => {
    scripts.push(script.content);
  });
  const page = { exposeBinding, addInitScript } as unknown as Page;
  const config = () => JSON.parse(scripts[0]!.slice('__chwInit('.length, -');'.length)) as PageConfig;
  return { page, exposeBinding, addInitScript, scripts, config };
}

/**
 * fetch answering queryNetwork/genesisConfiguration the way Ogmios does, directly or behind Koios' /ogmios.
 * The fields are those of an Ogmios 7.0.0 answer, network and magic set per test. Anything else is a 500.
 */
function genesisFetch(network: 'mainnet' | 'testnet') {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method?: string; id?: unknown };
    if (request.method !== 'queryNetwork/genesisConfiguration') return new Response('unexpected request', { status: 500 });
    const result = { era: 'shelley', networkMagic: network === 'mainnet' ? 764824073 : 1, network };
    return new Response(JSON.stringify({ jsonrpc: '2.0', method: request.method, result, id: request.id ?? null }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('attachWallet with ledger.chain', () => {
  it('checks the network first, then exposes the binding and installs a config with only the chain flag', async () => {
    const fetch = genesisFetch('testnet');
    vi.stubGlobal('fetch', fetch);
    const { page, exposeBinding, scripts, config } = fakePage();
    await attachWallet(page, { ledger: { chain: OGMIOS } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.invocationCallOrder[0]!).toBeLessThan(exposeBinding.mock.invocationCallOrder[0]!);
    expect(exposeBinding).toHaveBeenCalledWith(LEDGER_BINDING, expect.any(Function));
    expect(config().ledger).toEqual({ state: true, chain: true, binding: LEDGER_BINDING });
    expect(config().utxos).toEqual([]);
    expect(scripts[0]).not.toContain('localhost:1337');
  });

  it('locks signTx when the provider reports mainnet', async () => {
    vi.stubGlobal('fetch', genesisFetch('mainnet'));
    const { page, config } = fakePage();
    await attachWallet(page, { networkId: 1, ledger: { chain: OGMIOS } });
    expect(config().ledger).toEqual({ state: true, chain: true, binding: LEDGER_BINDING, signLocked: true });
  });

  it('allowMainnetSigning: true leaves signTx unlocked on mainnet', async () => {
    vi.stubGlobal('fetch', genesisFetch('mainnet'));
    const { page, config } = fakePage();
    await attachWallet(page, { networkId: 1, ledger: { chain: { ...OGMIOS, allowMainnetSigning: true } } });
    expect(config().ledger).toEqual({ state: true, chain: true, binding: LEDGER_BINDING });
  });

  it.each([
    [0, 'mainnet', 'ledger.chain: ogmios reports mainnet (networkId 1), walletOptions.networkId is 0'],
    [1, 'testnet', 'ledger.chain: ogmios reports a test network (networkId 0), walletOptions.networkId is 1'],
  ] as const)('refuses networkId %s on a %s chain before anything reaches the page', async (networkId, network, message) => {
    vi.stubGlobal('fetch', genesisFetch(network));
    const { page, exposeBinding, addInitScript } = fakePage();
    await expect(attachWallet(page, { networkId, ledger: { chain: OGMIOS } })).rejects.toThrow(message);
    expect(exposeBinding).not.toHaveBeenCalled();
    expect(addInitScript).not.toHaveBeenCalled();
  });

  it('koios sends the token as a bearer header and never into the page', async () => {
    const fetch = genesisFetch('testnet');
    vi.stubGlobal('fetch', fetch);
    const { page, scripts } = fakePage();
    await attachWallet(page, { ledger: { chain: { provider: 'koios', network: 'preprod', token: 'secret-token' } } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url).startsWith('https://preprod.koios.rest/api/v1')).toBe(true);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
    expect(scripts[0]).not.toContain('secret-token');
  });

  it('a provider out of reach fails with CHW_CHAIN_UNAVAILABLE without the token, and a later attach of the same page works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const { page, config } = fakePage();
    const options = { ledger: { chain: { provider: 'koios', network: 'preprod', token: 'secret-token' } } } as const;
    const e = await rejectionOf(attachWallet(page, options));
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE' });
    expect((e as Error).message).not.toContain('secret-token');

    vi.stubGlobal('fetch', genesisFetch('testnet'));
    await attachWallet(page, options);
    expect(config().ledger).toEqual({ state: true, chain: true, binding: LEDGER_BINDING });
  });

  it('with install: false still checks the network, and nothing reaches the page', async () => {
    vi.stubGlobal('fetch', genesisFetch('mainnet'));
    const refused = fakePage();
    await expect(attachWallet(refused.page, { install: false, ledger: { chain: OGMIOS } })).rejects.toThrow('ledger.chain: ogmios reports mainnet (networkId 1), walletOptions.networkId is 0');

    vi.stubGlobal('fetch', genesisFetch('testnet'));
    const { page, exposeBinding, addInitScript } = fakePage();
    await attachWallet(page, { install: false, ledger: { chain: OGMIOS } });
    expect(exposeBinding).not.toHaveBeenCalled();
    expect(addInitScript).not.toHaveBeenCalled();
  });

  it('without ledger.chain no provider is asked and the page config is as before', async () => {
    const fetch = genesisFetch('testnet');
    vi.stubGlobal('fetch', fetch);
    const { page, config } = fakePage();
    await attachWallet(page, {});
    expect(fetch).not.toHaveBeenCalled();
    expect(config().ledger).toEqual({ state: true, binding: LEDGER_BINDING });
  });
});
