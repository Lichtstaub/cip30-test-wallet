# Recipes

Complete, tested patterns for the tasks that come up when a dApp is tested with this wallet. Every snippet here ran in Chromium, Firefox and WebKit against a small dApp built the way the recipe describes. The library recipes name the version they were tested with.

## Read this first: where the wallet's funds live

The wallet's UTxOs are synthetic. They exist inside the wallet only, not on any chain. That decides how a dApp has to be wired for a test to pass:

- **Build from the wallet.** A transaction builder must take its inputs from CIP-30 `getUtxos()`. Evolution SDK, Mesh and Lucid Evolution all do that when they are connected to the CIP-30 api, see their recipes below. A builder that looks the address up at Blockfrost, Koios or a chain indexer finds nothing, coin selection fails.
- **Protocol parameters still come from the network.** Fee calculation needs them. Serve them from a recorded answer and the test runs offline, see [Protocol parameters offline](#protocol-parameters-offline).
- **Nothing reaches a chain.** The wallet's `submitTx` records the transaction and returns its id. A library that submits through its own provider, or a dApp that hands the signed transaction to its backend, would send a transaction whose inputs do not exist. Intercept that request with `page.route` and check the transaction instead, see [A backend or provider that submits](#a-backend-or-provider-that-submits).
- **Chain checks cannot see synthetic funds.** A token-gated page, a balance read from an indexer or a check that an address is a registered DRep needs a wallet that really has that state on the dApp's network, passed in through `walletOptions.mnemonic`. See [Pages behind a wallet login](../README.md#pages-behind-a-wallet-login).

## Serving a test page on a fake origin

The recipes serve a bundled dApp on `https://dapp.test/` with `page.route`, so no dev server is needed. Against your own app use its dev server or deployed URL instead, the wallet is installed the same way.

Wait for something the app renders after its code has run before you click. A bundle with WebAssembly, as Lucid Evolution produces, can take a few seconds to start in Firefox, and a click on a button that is already in the static HTML is lost in that time.

```ts
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

const html = readFileSync('dapp/index.html', 'utf8');
const app = readFileSync('dapp/app.js', 'utf8');

export async function serve(page: Page) {
  await page.route('https://dapp.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: app });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('https://dapp.test/');
}
```

## Evolution SDK

Tested with `@evolution-sdk/evolution` 0.5.14.

A client built with `withCip30(api)` takes its UTxOs from the wallet's `getUtxos()`, no `availableUtxos` option needed. It asks Koios only for protocol parameters (`epoch_params`). It always signs with `signTx(tx, true)`, a partial signature.

```ts
// dApp side
import { Address, Assets, Client, preprod, TransactionHash } from '@evolution-sdk/evolution';

const api = await window.cardano[walletName].enable();
if ((await api.getNetworkId()) !== 0) throw new Error('wrong network: switch your wallet to preprod');

const client = Client.make(preprod).withKoios({ baseUrl: 'https://preprod.koios.rest/api/v1' }).withCip30(api);
const built = await client
  .newTx()
  .payToAddress({ address: Address.fromBech32(recipient), assets: Assets.fromLovelace(5_000_000n) })
  .build();
const txHash = TransactionHash.toHex(await built.signAndSubmit());
```

`signAndSubmit` submits through the provider, Koios here, never through the wallet's `submitTx`. In a test that request has to be intercepted:

```ts
import { test, expect, expectSignedBy } from 'cip30-test-wallet/playwright';

test.use({ walletOptions: { name: 'eternl', networkId: 0, utxos: [{ lovelace: 50_000_000 }, { lovelace: 3_000_000 }] } });

test('pays 5 ADA with a transaction the wallet really signed', async ({ page, wallet }) => {
  await stubProtocolParameters(page); // see "Protocol parameters offline"
  let submitted: string | undefined;
  await page.route('https://preprod.koios.rest/api/v1/submittx', async (route) => {
    submitted = route.request().postDataBuffer()!.toString('hex');
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify('cd'.repeat(32)),
    });
  });
  await serve(page);
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page.locator('#result')).toHaveText('submitted ' + 'cd'.repeat(32));

  expect((await wallet.calls('signTx'))[0]!.args[1]).toBe(true);
  expectSignedBy(submitted!, wallet);
});
```

When the user declines, `signAndSubmit` rejects with an Effect `FiberFailure` whose message ends in `[object Object]`, see [known consumer issues](known-consumer-issues.md#evolution-sdk-a-declined-signature-hides-its-cip-30-code). The CIP-30 code is still inside, under an Effect symbol:

```ts
// The CIP-30 code of a wallet error, also inside an Effect FiberFailure.
function cip30Code(e: any): number | undefined {
  const failure = e?.[Symbol.for('effect/Runtime/FiberFailure/Cause')]?.error;
  for (let c = failure ?? e; c; c = c.cause) if (typeof c.code === 'number') return c.code;
  return undefined;
}

try {
  await built.signAndSubmit();
} catch (e) {
  if (cip30Code(e) === 2) showMessage('You declined the signature in your wallet.');
  else throw e;
}
```

Or sign with the wallet directly, then the rejection is the CIP-30 object itself:

```ts
import { Transaction } from '@evolution-sdk/evolution';

const unsigned = Transaction.toCBORHex(await built.toTransaction());
try {
  const witnessSet = await api.signTx(unsigned, false);
  const signed = Transaction.addVKeyWitnessesHex(unsigned, witnessSet);
  // hand `signed` to api.submitTx or to your backend
} catch (e) {
  if (e?.code === 2) showMessage('You declined the signature in your wallet.');
  else throw e;
}
```

## Mesh

Tested with `@meshsdk/core` 1.9.1.

`BrowserWallet.getUtxos()` reads the wallet over CIP-30, but `MeshTxBuilder` does not find the wallet on its own: pass the UTxOs with `selectUtxosFrom`. Mesh needs no chain data for a payment, without `params` it calculates with built-in protocol parameters. Pass current ones through `new MeshTxBuilder({ params })` when the fee has to match the network. Mesh submits through the wallet's `submitTx`, so `wallet.lastSubmittedTx()` holds the transaction.

```ts
// dApp side
import { BrowserWallet, MeshTxBuilder } from '@meshsdk/core';

const wallet = await BrowserWallet.enable(walletName);
const builder = new MeshTxBuilder();
builder
  .txOut(recipient, [{ unit: 'lovelace', quantity: '5000000' }])
  .changeAddress(await wallet.getChangeAddress())
  .selectUtxosFrom(await wallet.getUtxos());
const unsigned = await builder.complete();
const signed = await wallet.signTx(unsigned);
const txHash = await wallet.submitTx(signed);
```

```ts
test('pays 5 ADA with Mesh', async ({ page, wallet }) => {
  await serve(page);
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText(/submitted [0-9a-f]{64}/)).toBeVisible();

  expectSignedBy((await wallet.lastSubmittedTx())!, wallet);
});
```

A declined signature reaches the dApp as the CIP-30 object `{ code: 2, info }`. The browser bundle needs polyfills for Node's `Buffer` and `process`, a bundler plugin for Node built-ins covers both.

## Lucid Evolution

Tested with `@lucid-evolution/lucid` 0.6.5.

`selectWallet.fromAPI(api)` takes the UTxOs from the wallet. `Lucid(new Koios(...), 'Preprod')` loads protocol parameters once at start, from `epoch_params?limit=1`, which the stub in [Protocol parameters offline](#protocol-parameters-offline) answers. Lucid signs with `signTx(tx, true)` and submits through the wallet's `submitTx`.

```ts
// dApp side
import { Koios, Lucid } from '@lucid-evolution/lucid';

const api = await window.cardano[walletName].enable();
const lucid = await Lucid(new Koios('https://preprod.koios.rest/api/v1'), 'Preprod');
lucid.selectWallet.fromAPI(api);
const tx = await lucid.newTx().pay.ToAddress(recipient, { lovelace: 5_000_000n }).complete();
const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
```

```ts
test('pays 5 ADA with Lucid Evolution', async ({ page, wallet }) => {
  await stubProtocolParameters(page);
  await serve(page);
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText(/submitted [0-9a-f]{64}/)).toBeVisible();

  expect((await wallet.calls('signTx'))[0]!.args[1]).toBe(true);
  expectSignedBy((await wallet.lastSubmittedTx())!, wallet);
});
```

A declined signature becomes a `(FiberFailure) TxSignerError` with the message `[object Object]`, the same wrapping as in Evolution SDK. The `cip30Code` helper from the Evolution recipe reads the code from it. Alternatively `tx.sign.withWallet().completeSafe()` returns the failure instead of throwing, its `left.cause` is the CIP-30 object. The browser bundle embeds WebAssembly and needs polyfills for Node built-ins. A page with a Content Security Policy has to allow `'wasm-unsafe-eval'` in `script-src`, plain `'unsafe-eval'` is not needed.

## Protocol parameters offline

Record the answer once and serve it from a file. For Koios preprod:

```bash
curl -s "https://preprod.koios.rest/api/v1/epoch_params?limit=1&order=epoch_no.desc" -o fixtures/koios-epoch-params.json
```

```ts
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

const epochParams = readFileSync('fixtures/koios-epoch-params.json', 'utf8');

export async function stubProtocolParameters(page: Page) {
  // Playwright tries the most recently added route first, so the catch-all goes in first.
  // Any other Koios call means the builder looked for chain data it cannot find.
  await page.route('https://preprod.koios.rest/**', (route) => route.abort());
  await page.route('https://preprod.koios.rest/api/v1/epoch_params*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      // The dApp runs on another origin, without this header the browser drops the answer.
      headers: { 'access-control-allow-origin': '*' },
      body: epochParams,
    }),
  );
}
```

Two details decide whether this works: the order of the two routes, and the CORS header. A missing header shows up in the dApp as a failed protocol parameter request. Record the file again when the network's parameters change, a stale file only changes the fee.

If the app goes through its own proxy, as many do because Koios sends no CORS headers, route the proxy path instead, for example `**/api/koios/**`.

## A backend or provider that submits

Whatever submits the signed transaction, intercept that request, keep the transaction and prove the signature on it. Nothing leaves the test.

```ts
test('the backend receives a transaction the wallet really signed', async ({ page, wallet }) => {
  let submitted: string | undefined;
  await page.route('**/api/submit', async (route) => {
    submitted = route.request().postDataJSON().tx;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ txHash: 'ab'.repeat(32) }) });
  });
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('ab'.repeat(32))).toBeVisible();

  expectSignedBy(submitted!, wallet);
  expect(await wallet.calls('submitTx')).toHaveLength(0);
});
```

For a provider that posts raw CBOR (Koios `submittx`, Blockfrost `tx/submit`) read the body with `route.request().postDataBuffer()!.toString('hex')`, as in the Evolution recipe.

## User-side failures

Each quirk reproduces one thing a real user or wallet does. The wallet answers with the error a real wallet sends, and the test checks what the dApp tells the user.

| The user... | walletOptions | What the dApp receives |
|---|---|---|
| declines the connection | `quirks: { enableRejected: true }` | `enable()` rejects with `{ code: -3 }` (APIError Refused) |
| declines the signature | `quirks: { signRejected: true }` | `signTx` rejects with `{ code: 2 }` (TxSignError UserDeclined) |
| declines to sign a message | `quirks: { signDataRejected: true }` | `signData` rejects with `{ code: 3 }` (DataSignError UserDeclined) |
| never answers the signature prompt | `quirks: { signHangs: true }` | `signTx` stays pending until the test calls `wallet.release('signTx')` or `wallet.reject('signTx')` |
| has the wallet on the other network | `networkId: 1` (dApp on a testnet) | `getNetworkId()` returns 1, addresses are mainnet addresses |
| has a wallet that injects late | `quirks: { lateInjection: 1500 }` | `window.cardano[name]` appears after 1.5 seconds |
| has a wallet without CIP-95 | `quirks: { noCip95: true }` | `supportedExtensions` is empty, `enable({ extensions: [{ cip: 95 }] })` grants nothing |

Every switch has a note with where it was observed in [quirks/README.md](../quirks/README.md).

```ts
test.describe('the user never answers the wallet', () => {
  test.use({ walletOptions: { quirks: { signHangs: true } } });

  test('the page waits, then reports the decline', async ({ page, wallet }) => {
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByText('Waiting for your wallet')).toBeVisible();
    await wallet.reject('signTx');
    await expect(page.getByText('You declined the signature')).toBeVisible();
  });
});
```

## Reading the journal

`wallet.calls()` lists every CIP-30 call of the current page in order, with arguments and result or error. It answers questions a screenshot cannot: did the dApp check the network before building, did it ask for a partial signature, did it retry.

```ts
test('connect checks the network before it reads addresses', async ({ page, wallet }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText('Connected')).toBeVisible();

  const methods = (await wallet.calls()).map((e) => e.method);
  expect(methods.indexOf('getNetworkId')).toBeLessThan(methods.indexOf('getUsedAddresses'));
  expect(await wallet.calls('signTx')).toHaveLength(0);
});
```

The journal lives in the page and starts empty after every navigation, see [fixture-api.md](fixture-api.md#state-lives-in-the-page). Read it before the dApp navigates away, or hold the navigation with `page.route` as the login recipe does.

## Testing a wallet module directly on a dev server

A dev server built on Vite (Vite, Astro, SvelteKit, Nuxt) serves source modules by path. A test can import the dApp's own wallet module in the page and call it, without clicking through a page that sits behind a login:

```ts
test.use({ walletOptions: { name: 'eternl', networkId: 0, utxos: [{ lovelace: 50_000_000 }] } });

test('the wallet connector connects and builds a signed payment', async ({ page, wallet }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const mod = await import('/src/lib/wallet-connector.ts');
    const connected = await mod.connectWallet('eternl', 0);
    const signed = await mod.buildPaymentTx('eternl', 'addr_test1...', 5_000_000);
    return { connected, signed };
  });
  expect(result.connected.networkId).toBe(0);
  expectSignedBy(result.signed, wallet);
});
```

Module path and function names are the app's own. Any request the module makes to a session-protected route, a chain proxy for example, can be served with `page.route` as above.

## Signing in with a message

See [Pages behind a wallet login](../README.md#pages-behind-a-wallet-login) for `signData` logins, a setup project and `storageState`, and [fixture-api.md](fixture-api.md#expectsigneddataresult-expected) for `expectSignedData`.

## Without the test runner

An agent that drives a browser through Playwright MCP, or any code that is not a Playwright test, loads the wallet from a script file. See [init-script.md](init-script.md).
