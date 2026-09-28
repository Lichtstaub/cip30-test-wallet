import { describe, expect, it } from 'vitest';
import { enterpriseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex } from '../src/core/bytes.js';
import { keyHash } from '../src/core/hash.js';
import { publicKey } from '../src/core/keys.js';
import { deriveAccount } from '../src/derive/index.js';
import { expectSignedData } from '../src/host/assert.js';
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
    await expect(call(null)).rejects.toMatchObject({ code: -1 });
  });

  it('treats an explicit undefined as no parameter', async () => {
    const api = await install().provider.enable(CIP95);
    const drep = api.cip95!.getPubDRepKey as unknown as (x: unknown) => Promise<string>;
    const registered = api.cip95!.getRegisteredPubStakeKeys as unknown as (x: unknown) => Promise<string[]>;
    expect(await drep(undefined)).toBe(bytesToHex(publicKey(account.drep)));
    expect(await registered(undefined)).toEqual([]);
  });

  it('journals the calls with the cip95 prefix', async () => {
    const { provider, control } = install();
    const api = await provider.enable(CIP95);
    await api.cip95!.getPubDRepKey();
    expect(control.journal.map((e) => e.method)).toContain('cip95.getPubDRepKey');
  });
});

describe('cip95.signData', () => {
  const drepPub = publicKey(account.drep);
  const bare = bytesToHex(keyHash(drepPub));
  const type6 = bytesToHex(enterpriseAddressBytes(0, keyHash(drepPub)));
  const payload = bytesToHex(new TextEncoder().encode('drep login'));

  it('signs with the DRep key for the bare DRep ID and for the type 6 address, echoing the form in the header', async () => {
    const api = await install().provider.enable(CIP95);
    for (const addr of [bare, type6]) {
      const r = await api.cip95!.signData(addr, payload);
      const info = expectSignedData(r, { payload, address: addr, publicKeyHex: bytesToHex(drepPub) });
      expect(bytesToHex(info.address)).toBe(addr);
    }
  });

  it('still signs payment and reward addresses like CIP-30', async () => {
    const api = await install().provider.enable(CIP95);
    const [reward] = await api.getRewardAddresses();
    const r = await api.cip95!.signData(reward!, payload);
    expectSignedData(r, { payload, address: reward!, publicKeyHex: bytesToHex(publicKey(account.stake)) });
  });

  it('never signs a DRep argument through the CIP-30 signData', async () => {
    const api = await install().provider.enable(CIP95);
    await expect(api.signData(bare, payload)).rejects.toMatchObject({ code: -1 });
    await expect(api.signData(type6, payload)).rejects.toMatchObject({ code: 1 });
  });

  it('bareOnly rejects the type 6 form with UserDeclined and signs the bare form', async () => {
    const api = await install({ quirks: { cip95SignData: 'bareOnly' } }).provider.enable(CIP95);
    await expect(api.cip95!.signData(type6, payload)).rejects.toMatchObject({ code: 3 });
    await expect(api.cip95!.signData(bare, payload)).resolves.toBeDefined();
  });

  it('type6Only rejects the bare form with ProofGeneration and signs the type 6 form', async () => {
    const api = await install({ quirks: { cip95SignData: 'type6Only' } }).provider.enable(CIP95);
    await expect(api.cip95!.signData(bare, payload)).rejects.toMatchObject({ code: 1 });
    await expect(api.cip95!.signData(type6, payload)).resolves.toBeDefined();
  });

  it('coseAddress bareKeyHash puts the bare hash into the header for a type 6 request', async () => {
    const api = await install({ quirks: { coseAddress: 'bareKeyHash' } }).provider.enable(CIP95);
    const r = await api.cip95!.signData(type6, payload);
    expect(() => expectSignedData(r, { payload })).toThrow(/bare 28 byte key hash/);
    expect(bytesToHex(expectSignedData(r, { payload, allowBareKeyHash: true }).address)).toBe(bare);
    expect(bytesToHex(expectSignedData(r, { payload, address: bare }).address)).toBe(bare);
  });

  it('signDataRejected also applies to cip95.signData', async () => {
    const api = await install({ quirks: { signDataRejected: true } }).provider.enable(CIP95);
    await expect(api.cip95!.signData(bare, payload)).rejects.toMatchObject({ code: 3 });
  });
});
