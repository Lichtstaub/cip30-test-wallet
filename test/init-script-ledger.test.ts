import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { PAGE_BUNDLE_OPTIONS } from '../scripts/page-bundle.mjs';
import { parseAddressArg } from '../src/core/sign-data.js';
import { prepareWallet } from '../src/host/config.js';
import { syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { runInBareWindow, type TestApi } from './helpers/page.js';

type Provider = { enable(): Promise<TestApi> };

describe('the init-script mode keeps the ledger in the page', () => {
  it('applies a submit until the next load, a new load starts from the configuration', async () => {
    const source = (await build({ ...PAGE_BUNDLE_OPTIONS, write: false, logLevel: 'silent' })).outputFiles[0]!.text;
    const w = prepareWallet();
    const load = () => runInBareWindow(`${source}\n;__chwInit(${JSON.stringify(w.config)});`);
    const api = async (window: Record<string, unknown>) => ((window['cardano'] as Record<string, Provider>)['chw']!).enable();

    const first = await api(load());
    const address = parseAddressArg(w.addresses.payment);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const id = await first.submitTx(buildTx({ inputs: [utxo0.input], outputs: [{ address, lovelace: 9_000_000n }], fee: 1n }));
    const afterSubmit = (await first.getUtxos())!;
    expect(afterSubmit).toHaveLength(1);
    expect(afterSubmit[0]).toContain(id);

    const reloaded = (await (await api(load())).getUtxos())!;
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).not.toContain(id);
  });
});
