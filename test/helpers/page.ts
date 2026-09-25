import { bytesToHex } from '../../src/core/bytes.js';
import { deriveAccount } from '../../src/derive/index.js';
import type { PageConfig } from '../../src/page/config.js';
import type { InstallTarget } from '../../src/page/install.js';
import type { Cip30Api, Cip30Provider } from '../../src/page/provider.js';
import { MNEMONIC } from '../fixtures/vectors.js';

export function testConfig(overrides: Partial<PageConfig> = {}): PageConfig {
  const account = deriveAccount(MNEMONIC);
  return {
    name: 'chw',
    displayName: 'Test Wallet',
    icon: '',
    networkId: 0,
    keys: {
      payment: { kind: account.payment.kind, hex: bytesToHex(account.payment.bytes) },
      stake: { kind: account.stake.kind, hex: bytesToHex(account.stake.bytes) },
      drep: { kind: account.drep.kind, hex: bytesToHex(account.drep.bytes) },
    },
    utxos: [{ lovelace: '10000000' }, { lovelace: '4500000' }],
    foreignUtxos: [],
    quirks: {},
    stakeRegistered: false,
    ...overrides,
  };
}

export type TestApi = Cip30Api;

/** The chw provider under window.cardano, typed instead of cast ad hoc at every call site. */
export function chwProvider(target: InstallTarget): Cip30Provider {
  return (target.cardano as Record<string, Cip30Provider>)['chw']!;
}

/** Calls isEnabled and enable on the installed chw provider and returns the api. */
export async function enableChw(target: InstallTarget): Promise<TestApi> {
  const provider = chwProvider(target);
  await provider.isEnabled();
  return (await provider.enable({ extensions: [] })) as TestApi;
}
