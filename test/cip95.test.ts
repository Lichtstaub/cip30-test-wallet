import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { publicKey } from '../src/core/keys.js';
import { deriveAccount } from '../src/derive/index.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import type { PageConfig } from '../src/page/config.js';
import { MNEMONIC } from './fixtures/vectors.js';
import { chwProvider, testConfig } from './helpers/page.js';

const account = deriveAccount(MNEMONIC);
const CIP95 = { extensions: [{ cip: 95 }] };

function install(overrides: Partial<PageConfig> = {}) {
  const target: InstallTarget = {};
  const control = installWallet(testConfig(overrides), target);
  return { target, control, provider: chwProvider(target) };
}

describe('CIP-95 handshake', () => {
  it('announces CIP-95 before enable and is found by Object.entries', () => {
    const { target } = install();
    const entries = Object.entries(target.cardano as object);
    expect(entries.map(([k]) => k)).toContain('chw');
    const [, provider] = entries.find(([k]) => k === 'chw')!;
    expect((provider as { supportedExtensions: unknown }).supportedExtensions).toEqual([{ cip: 95 }]);
  });

  it('attaches the namespace only to an api whose enable asked for CIP-95', async () => {
    const { provider } = install();
    const plain = await provider.enable();
    const withCip95 = await provider.enable(CIP95);
    expect(plain.cip95).toBeUndefined();
    expect(await plain.getExtensions()).toEqual([]);
    expect(withCip95.cip95).toBeDefined();
    expect(await withCip95.getExtensions()).toEqual([{ cip: 95 }]);
    expect(plain.cip95).toBeUndefined();
  });

  it('ignores unknown extensions', async () => {
    const { provider } = install();
    const api = await provider.enable({ extensions: [{ cip: 999 }, { cip: 95 }] });
    expect(await api.getExtensions()).toEqual([{ cip: 95 }]);
  });

  it('noCip95 removes the extension everywhere', async () => {
    const { provider } = install({ quirks: { noCip95: true } });
    expect(provider.supportedExtensions).toEqual([]);
    const api = await provider.enable(CIP95);
    expect(api.cip95).toBeUndefined();
    expect(await api.getExtensions()).toEqual([]);
  });

  it('cip95NamespaceMissing claims the extension but leaves the namespace out', async () => {
    const { provider } = install({ quirks: { cip95NamespaceMissing: true } });
    expect(provider.supportedExtensions).toEqual([{ cip: 95 }]);
    const api = await provider.enable(CIP95);
    expect(await api.getExtensions()).toEqual([{ cip: 95 }]);
    expect(api.cip95).toBeUndefined();
  });

  it('noCip95 set at runtime changes supportedExtensions at once and the grant from the next enable on', async () => {
    const { provider, control } = install();
    const before = await provider.enable(CIP95);
    control.setQuirk('noCip95', true);
    expect(provider.supportedExtensions).toEqual([]);
    expect(before.cip95).toBeDefined();
    expect(await before.getExtensions()).toEqual([{ cip: 95 }]);
    const after = await provider.enable(CIP95);
    expect(after.cip95).toBeUndefined();
    expect(await after.getExtensions()).toEqual([]);
  });
});

describe('CIP-95 key endpoints', () => {
  it('returns the DRep public key', async () => {
    const api = await install().provider.enable(CIP95);
    expect(await api.cip95!.getPubDRepKey()).toBe(bytesToHex(publicKey(account.drep)));
  });

  it('reports an unregistered stake key by default and a registered one on request', async () => {
    const stakeHex = bytesToHex(publicKey(account.stake));
    const fresh = await install().provider.enable(CIP95);
    expect(await fresh.cip95!.getRegisteredPubStakeKeys()).toEqual([]);
    expect(await fresh.cip95!.getUnregisteredPubStakeKeys()).toEqual([stakeHex]);
    const registered = await install({ stakeRegistered: true }).provider.enable(CIP95);
    expect(await registered.cip95!.getRegisteredPubStakeKeys()).toEqual([stakeHex]);
    expect(await registered.cip95!.getUnregisteredPubStakeKeys()).toEqual([]);
  });

  it('answers InvalidRequest when a parameter is passed', async () => {
    const api = await install().provider.enable(CIP95);
    const call = api.cip95!.getPubDRepKey as unknown as (x: unknown) => Promise<string>;
    await expect(call('x')).rejects.toMatchObject({ code: -1 });
  });

  it('journals the calls with the cip95 prefix', async () => {
    const { provider, control } = install();
    const api = await provider.enable(CIP95);
    await api.cip95!.getPubDRepKey();
    expect(control.journal.map((e) => e.method)).toContain('cip95.getPubDRepKey');
  });
});
