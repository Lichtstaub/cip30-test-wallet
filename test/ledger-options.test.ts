import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInitScript } from '../src/cli/init-script.js';
import { initScript } from '../src/host/bundle.js';
import { DEFAULT_COST_MODELS } from '../src/host/cost-models.js';
import { prepareWallet, type WalletOptions } from '../src/host/config.js';
import { LEDGER_BINDING } from '../src/host/ledger.js';
import { DEFAULT_PROTOCOL_PARAMS } from '../src/host/protocol-params.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { enableChw } from './helpers/page.js';

afterEach(() => vi.restoreAllMocks());

describe('walletOptions.quirks.submitFails', () => {
  it('takes true or a non-empty string, false is off and so is leaving it out', () => {
    expect(prepareWallet({ quirks: { submitFails: true } }).config.quirks.submitFails).toBe(true);
    expect(prepareWallet({ quirks: { submitFails: 'rejected' } }).config.quirks.submitFails).toBe('rejected');
    expect(() => prepareWallet({ quirks: { submitFails: false } })).not.toThrow();
    expect(prepareWallet({ quirks: {} }).config.quirks.submitFails).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
  ])('refuses %s, it would silently do nothing or give an empty info', (_name, value) => {
    expect(() => prepareWallet({ quirks: { submitFails: value as never } })).toThrow(
      `quirks.submitFails must be true or a non-empty string, the info the dApp receives, got ${String(value)}`,
    );
  });
});

describe('walletOptions.ledger', () => {
  it('without checks keeps the page config as before and prepares no checks', () => {
    expect(prepareWallet().config.ledger).toEqual({ state: true });
    expect(prepareWallet({ ledger: { state: false } }).config.ledger).toEqual({ state: false });
    expect(prepareWallet({ ledger: { checks: false } }).ledgerChecks).toBeUndefined();
    expect('ledgerChecks' in prepareWallet()).toBe(false);
  });

  it('checks: true marks the page config and resolves the defaults of the network', () => {
    const w = prepareWallet({ ledger: { checks: true } });
    expect(w.config.ledger).toEqual({ state: true, checks: true });
    expect(w.ledgerChecks).toEqual({ params: DEFAULT_PROTOCOL_PARAMS[0], currentSlot: undefined, drepRegistered: false, network: 'preprod' });
    expect(prepareWallet({ networkId: 1, ledger: { checks: true } }).ledgerChecks).toMatchObject({ params: DEFAULT_PROTOCOL_PARAMS[1], network: 'mainnet' });
    // Only the flag reaches the page, the config stays JSON.
    expect(JSON.parse(JSON.stringify(w.config))).toEqual(w.config);
  });

  it('takes protocolParams, currentSlot and drepRegistered with checks', () => {
    const w = prepareWallet({ ledger: { checks: true, protocolParams: { minFeeA: '45', priceMem: 0.06 }, currentSlot: 110_000_000, drepRegistered: true } });
    expect(w.ledgerChecks).toEqual({
      params: { ...DEFAULT_PROTOCOL_PARAMS[0], minFeeA: 45n, priceMem: { numerator: 3n, denominator: 50n } },
      currentSlot: 110_000_000n,
      drepRegistered: true,
      network: 'preprod',
    });
    expect(prepareWallet({ ledger: { checks: true, currentSlot: 2n ** 40n } }).ledgerChecks!.currentSlot).toBe(2n ** 40n);
    expect(prepareWallet({ ledger: { checks: true, currentSlot: 0 } }).ledgerChecks!.currentSlot).toBe(0n);
  });

  it('network picks the slot calendar only, the parameters and the page config stay with networkId', () => {
    const preview = prepareWallet({ ledger: { checks: true, network: 'preview' } });
    expect(preview.ledgerChecks).toMatchObject({ params: DEFAULT_PROTOCOL_PARAMS[0], network: 'preview' });
    expect(preview.config.ledger).toEqual({ state: true, checks: true });
    expect(preview.config.networkId).toBe(0);
    expect(prepareWallet({ ledger: { checks: true, network: 'preprod' } }).ledgerChecks!.network).toBe('preprod');
    expect(prepareWallet({ networkId: 1, ledger: { checks: true, network: 'mainnet' } }).ledgerChecks!.network).toBe('mainnet');
  });

  it('takes cost models in the Koios form and the protocol version with checks', () => {
    const w = prepareWallet({ ledger: { checks: true, protocolParams: { costModels: { PlutusV2: [1, -2, '3'] }, protocolMajorVersion: 10 } } });
    expect(w.ledgerChecks!.params.costModels).toEqual({ ...DEFAULT_COST_MODELS, PlutusV2: [1n, -2n, 3n] });
    expect(w.ledgerChecks!.params.protocolMajorVersion).toBe(10n);
    // The page never sees parameters, the config stays JSON.
    expect(JSON.parse(JSON.stringify(w.config))).toEqual(w.config);
  });

  it.each([
    [0, 'mainnet', 'ledger.network mainnet needs networkId 1, got networkId 0'],
    [1, 'preprod', 'ledger.network preprod needs networkId 0, got networkId 1'],
    [1, 'preview', 'ledger.network preview needs networkId 0, got networkId 1'],
  ] as const)('refuses networkId %s with network %s, the addresses and the calendar would disagree', (networkId, network, message) => {
    expect(() => prepareWallet({ networkId, ledger: { checks: true, network } })).toThrow(message);
  });

  it.each([
    ['ledger that is no object', true, 'ledger must be an object, got true'],
    ['ledger that is null', null, 'ledger must be an object, got null'],
    ['an unknown ledger key', { check: true }, 'ledger.check is not a ledger option, known: state, checks, protocolParams, currentSlot, drepRegistered, network'],
    ['network without checks', { network: 'preview' }, 'ledger.network only applies with ledger.checks: true'],
    ['an unknown network', { checks: true, network: 'sanchonet' }, 'ledger.network must be one of mainnet, preprod, preview, got sanchonet'],
    ['a network in capitals', { checks: true, network: 'Preview' }, 'ledger.network must be one of mainnet, preprod, preview, got Preview'],
    ['a networkId as network', { checks: true, network: 0 }, 'ledger.network must be one of mainnet, preprod, preview, got 0'],
    ['network that is null', { checks: true, network: null }, 'ledger.network must be one of mainnet, preprod, preview, got null'],
    ['an inherited name as network', { checks: true, network: 'toString' }, 'ledger.network must be one of mainnet, preprod, preview, got toString'],
    ['a bad cost model', { checks: true, protocolParams: { costModels: { PlutusV3: [] } } }, 'ledger.protocolParams.costModels.PlutusV3 must be a non-empty array of integers, got []'],
    ['state that is no boolean', { state: 'yes' }, 'ledger.state must be a boolean, got yes'],
    ['checks that is no boolean', { checks: 'true' }, 'ledger.checks must be a boolean, got true'],
    ['checks with state false', { checks: true, state: false }, 'ledger.checks: true needs ledger.state: true'],
    ['protocolParams without checks', { protocolParams: { minFeeA: 44 } }, 'ledger.protocolParams only applies with ledger.checks: true'],
    ['currentSlot with checks false', { checks: false, currentSlot: 1 }, 'ledger.currentSlot only applies with ledger.checks: true'],
    ['drepRegistered without checks', { drepRegistered: true }, 'ledger.drepRegistered only applies with ledger.checks: true'],
    ['a negative currentSlot', { checks: true, currentSlot: -1 }, 'ledger.currentSlot must be a non-negative integer slot number as number or bigint, got -1'],
    ['a fractional currentSlot', { checks: true, currentSlot: 1.5 }, 'ledger.currentSlot must be a non-negative integer slot number as number or bigint, got 1.5'],
    ['a currentSlot string', { checks: true, currentSlot: '100' }, 'ledger.currentSlot must be a non-negative integer slot number as number or bigint, got 100'],
    ['drepRegistered that is no boolean', { checks: true, drepRegistered: 1 }, 'ledger.drepRegistered must be a boolean, got 1'],
    ['an unknown protocol parameter', { checks: true, protocolParams: { minFeeC: 1 } }, 'ledger.protocolParams.minFeeC is not a parameter the checks read'],
    ['a bad protocol parameter', { checks: true, protocolParams: { minFeeA: -44 } }, 'ledger.protocolParams.minFeeA must be a non-negative integer'],
    ['protocolParams that is no object', { checks: true, protocolParams: 'preprod' }, 'ledger.protocolParams must be an object of parameter overrides'],
    // Only undefined takes the default, null is a mistake in the options and never switches anything off.
    ['state that is null', { state: null }, 'ledger.state must be a boolean, got null'],
    ['checks that is null', { checks: null }, 'ledger.checks must be a boolean, got null'],
    ['drepRegistered that is null', { checks: true, drepRegistered: null }, 'ledger.drepRegistered must be a boolean, got null'],
    ['a currentSlot above 2^64 - 1', { checks: true, currentSlot: 2n ** 64n }, 'ledger.currentSlot must be a non-negative integer slot number as number or bigint, got 18446744073709551616'],
    ['currentSlot that is null', { checks: true, currentSlot: null }, 'ledger.currentSlot must be a non-negative integer slot number as number or bigint, got null'],
    ['protocolParams that is null', { checks: true, protocolParams: null }, 'ledger.protocolParams must be an object of parameter overrides, got null'],
  ])('refuses %s', (_name, ledger, message) => {
    expect(() => prepareWallet({ ledger } as unknown as WalletOptions)).toThrow(message);
  });
});

describe('the ledger checks run in Node only', () => {
  it('initScript refuses a config with checks and no host binding, before it reads the bundle', () => {
    expect(() => initScript(prepareWallet({ ledger: { checks: true } }).config)).toThrow(/ledger\.checks needs the ledger in Node of the Playwright fixture or of attachWallet/);
  });

  it.skipIf(!existsSync('dist/page.js'))('initScript takes checks with a host binding, the config attachWallet builds', () => {
    const { config } = prepareWallet({ ledger: { checks: true } });
    expect(initScript({ ...config, ledger: { ...config.ledger!, binding: LEDGER_BINDING } })).toContain('__chwInit(');
  });

  it('the init-script command refuses an options file with checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chw-checks-'));
    try {
      const file = join(dir, 'w.json');
      writeFileSync(file, JSON.stringify({ ledger: { checks: true } }));
      expect(() => runInitScript({ optionsFile: file }, {})).toThrow(/ledger\.checks needs the ledger in Node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a page with checks and a missing binding warns once, naming the binding and the missing checks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { config } = prepareWallet({ ledger: { checks: true } });
    const page: InstallTarget = {};
    installWallet({ ...config, ledger: { ...config.ledger!, binding: LEDGER_BINDING } }, page);
    expect(await (await enableChw(page)).getUtxos()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(LEDGER_BINDING));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('submitTx runs no ledger checks'));
  });

  it('a page with checks and no binding at all warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installWallet(prepareWallet({ ledger: { checks: true } }).config, {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('submitTx runs no ledger checks'));
  });

  it('a page without checks and without binding stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installWallet(prepareWallet().config, {});
    expect(warn).not.toHaveBeenCalled();
  });
});
