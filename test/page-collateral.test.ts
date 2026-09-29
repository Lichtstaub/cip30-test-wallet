import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { APIErrorCode } from '../src/core/errors.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import type { PageConfig } from '../src/page/config.js';
import { enableChw, testConfig } from './helpers/page.js';

const P = 'ab'.repeat(28);
type CollateralApi = { getCollateral?: (p?: unknown) => Promise<string[] | null>; experimental?: { getCollateral: (p?: unknown) => Promise<string[] | null> } };

async function api(overrides: Partial<PageConfig> = {}) {
  const target: InstallTarget = {};
  const control = installWallet(testConfig(overrides), target);
  return { api: (await enableChw(target)) as unknown as CollateralApi, control };
}
const coins = (list: string[] | null) => list?.map((h) => (decode(hexToBytes(h)) as [unknown, [unknown, bigint]])[1][1]);
const cbor = (n: bigint) => bytesToHex(encode(n));
const invalid = expect.objectContaining({ code: APIErrorCode.InvalidRequest });

describe('getCollateral', () => {
  const utxos = [{ lovelace: '9000000', assets: { [P]: '1' } }, { lovelace: '2000000' }, { lovelace: '4000000' }];

  it('without an argument means 5 ADA, the way Mesh calls it', async () => {
    const { api: a } = await api({ utxos });
    expect(coins(await a.getCollateral!())).toEqual([2_000_000n, 4_000_000n]);
    expect(coins(await a.getCollateral!({}))).toEqual([2_000_000n, 4_000_000n]);
  });

  it('takes amount as CBOR hex, number or bigint', async () => {
    const { api: a } = await api({ utxos });
    expect(coins(await a.getCollateral!({ amount: cbor(1_000_000n) }))).toEqual([2_000_000n]);
    expect(coins(await a.getCollateral!({ amount: 1_000_000 }))).toEqual([2_000_000n]);
    expect(coins(await a.getCollateral!({ amount: 1_000_000n }))).toEqual([2_000_000n]);
  });

  it('reads a string as CBOR hex, so "10" is 16 lovelace', async () => {
    const { api: a, control } = await api({ utxos: [{ lovelace: '16' }, { lovelace: '100' }] });
    expect(coins(await a.getCollateral!({ amount: '10' }))).toEqual([16n]);
    expect(control.journal.at(-1)!.method).toBe('getCollateral');
  });

  it('refuses more than 5 ADA, a bare value, and malformed amounts', async () => {
    const { api: a } = await api({ utxos });
    for (const bad of [{ amount: 5_000_001 }, { amount: cbor(5_000_001n) }, cbor(1n), 7, [1], { amount: -1 }, { amount: 0 }, { amount: cbor(0n) }, { amount: 'zz' }, { amount: bytesToHex(encode([1n, new Map()] as never)) }, { amount: 1.5 }]) {
      await expect(a.getCollateral!(bad)).rejects.toEqual(invalid);
    }
  });

  it('returns null when pure ADA is not enough, never a token-holding UTxO', async () => {
    expect(await (await api({ utxos: [{ lovelace: '50000000', assets: { [P]: '1' } }] })).api.getCollateral!()).toBeNull();
    expect(await (await api({ utxos: [{ lovelace: '1000000' }] })).api.getCollateral!()).toBeNull();
  });

  it('answers the same through experimental.getCollateral, journaled under its own name', async () => {
    const { api: a, control } = await api({ utxos });
    expect(await a.experimental!.getCollateral()).toEqual(await a.getCollateral!());
    expect(control.journal.some((e) => e.method === 'experimental.getCollateral')).toBe(true);
  });

  it('noCollateral: both methods are missing, the case the CIP-30 deprecation allows', async () => {
    const { api: a } = await api({ utxos, quirks: { noCollateral: true } });
    expect(a.getCollateral).toBeUndefined();
    expect(a.experimental).toBeUndefined();
  });

  it('noCollateral set at runtime takes effect on the next enable', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig({ utxos }), target);
    control.setQuirk('noCollateral', true);
    expect(((await enableChw(target)) as unknown as CollateralApi).getCollateral).toBeUndefined();
  });
});
