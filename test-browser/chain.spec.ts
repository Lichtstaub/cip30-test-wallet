// The wallet in chain mode in a real browser: chain UTxOs on the demo page, a payment the devnet
// confirms, the balance before and after, and a read while the chain does not answer. Runs only
// when CHW_DEVNET_OGMIOS names an Ogmios endpoint, npm run test:devnet:browser starts a devnet for it.
// The wallet reaches that Ogmios through a local proxy a test can switch off.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { hexToBytes } from '../src/core/bytes.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { ogmiosProvider } from '../src/host/chain/ogmios.js';
import { test as base, expect } from '../src/playwright/index.js';
import { buildTx, spliceWitnessSet, TEST_ADDRESS } from '../test/helpers/build-tx.js';

const OGMIOS = process.env.CHW_DEVNET_OGMIOS;

type Api = { getUtxos(): Promise<string[] | null>; signTx(tx: string, partialSign: boolean): Promise<string>; submitTx(tx: string): Promise<string> };
type ChwWindow = { cardano: { chw: { enable(): Promise<Api> } } };

/** A proxy in front of the devnet's Ogmios. While down is true it answers every request with HTTP 503. */
interface OgmiosProxy {
  url: string;
  down: boolean;
}

const test = base.extend<object, { ogmiosProxy: OgmiosProxy }>({
  ogmiosProxy: [
    async ({}, use) => {
      const proxy: OgmiosProxy = { url: '', down: false };
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        if (proxy.down) {
          response.writeHead(503).end();
          return;
        }
        try {
          const answer = await fetch(OGMIOS!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
          response.writeHead(answer.status, { 'content-type': 'application/json' }).end(await answer.text());
        } catch {
          response.writeHead(502).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await use(proxy);
      await new Promise((resolve) => server.close(resolve));
    },
    { scope: 'worker' },
  ],
  walletOptions: async ({ ogmiosProxy }, use) => {
    await use({ accountIndex: 9, ledger: { chain: { provider: 'ogmios', url: ogmiosProxy.url } } });
  },
});

test.skip(!OGMIOS, 'needs a devnet: npm run test:devnet:browser starts one, or set CHW_DEVNET_OGMIOS to an Ogmios URL');

async function connect(page: Page) {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
}

async function expectBalance(page: Page, lovelace: bigint) {
  await page.locator('#balance').click();
  await expect(page.locator('#balance-result')).toHaveText(`${lovelace} lovelace, 0 token kinds`);
}

test('pays from chain UTxOs on the demo page and the balance follows the devnet', async ({ page, wallet }) => {
  await connect(page);
  const utxos = await wallet.utxos();
  expect(utxos.length).toBeGreaterThan(0);
  const funds = utxos.reduce((sum, u) => sum + BigInt(u.lovelace), 0n);
  await expectBalance(page, funds);

  const [input] = utxos;
  const fee = 200_000n;
  const tx = buildTx({
    inputs: [{ txId: hexToBytes(input!.txId), index: BigInt(input!.index) }],
    outputs: [
      { address: TEST_ADDRESS, lovelace: 5_000_000n },
      { address: parseAddressArg(wallet.addresses.payment), lovelace: BigInt(input!.lovelace) - 5_000_000n - fee },
    ],
    fee,
  });
  const witnessSet = await page.evaluate(async (hex) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(hex, false), tx);
  const id = await page.evaluate(async (hex) => (await (window as unknown as ChwWindow).cardano.chw.enable()).submitTx(hex), spliceWitnessSet(tx, witnessSet));

  // The wallet shows the change at once, whether the block is out yet or not.
  await expectBalance(page, funds - 5_000_000n - fee);

  // The devnet confirms it, and a reloaded page reads the same balance from the chain.
  const provider = ogmiosProvider({ url: OGMIOS! });
  await expect.poll(async () => (await provider.unspentOutputs([{ txId: hexToBytes(id), index: 1n }])).length, { timeout: 30_000 }).toBe(1);
  await page.reload();
  await connect(page);
  await expectBalance(page, funds - 5_000_000n - fee);
});

test('a read while the chain does not answer rejects in the page with ChwError CHW_CHAIN_UNAVAILABLE, the next read works', async ({ page, ogmiosProxy }) => {
  await connect(page);
  ogmiosProxy.down = true;
  try {
    // Caught in the page, so name, code and message come back as data, the way a dApp sees them.
    const outcome = await page.evaluate(async () => {
      const api = await (window as unknown as ChwWindow).cardano.chw.enable();
      try {
        await api.getUtxos();
        return { rejected: false };
      } catch (e) {
        const error = e as { name?: unknown; code?: unknown; message?: unknown };
        return { rejected: true, name: error.name, code: error.code, message: error.message };
      }
    });
    expect(outcome).toEqual({ rejected: true, name: 'ChwError', code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: HTTP 503' });
  } finally {
    ogmiosProxy.down = false;
  }
  const utxos = await page.evaluate(async () => (await (window as unknown as ChwWindow).cardano.chw.enable()).getUtxos());
  expect(utxos?.length).toBeGreaterThan(0);
});
