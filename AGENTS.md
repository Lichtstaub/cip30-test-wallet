# cip30-test-wallet for coding agents

This package injects a CIP-30 Cardano wallet into a page under Playwright. It connects, signs and answers without a popup, so an agent can test a dApp's wallet flows unattended and check its own changes.

## Where to look

| Task | File |
|---|---|
| Adding the wallet to an existing dApp step by step, logins with `signData` | [README.md](README.md#getting-started) |
| Every `walletOptions` field and `wallet` handle member | [docs/fixture-api.md](docs/fixture-api.md) |
| Building and submitting transactions with Evolution SDK, Mesh or Lucid Evolution, backends that submit, offline protocol parameters, user-side failures, the journal | [docs/recipes.md](docs/recipes.md) |
| Reproducing a specific wallet or user behaviour | [quirks/README.md](quirks/README.md) |
| A browser driven through Playwright MCP instead of a test file | [docs/init-script.md](docs/init-script.md) |
| Checking a deployed dApp for CSP and detection problems | [docs/doctor.md](docs/doctor.md) |
| A library that misbehaves against a spec-conformant wallet | [docs/known-consumer-issues.md](docs/known-consumer-issues.md) |

In an installed project these files are under `node_modules/cip30-test-wallet/`.

## Rules that save a debugging round

- Import `test`, `expect`, `expectSignedBy` and `expectSignedData` from `cip30-test-wallet/playwright`, not from `@playwright/test`.
- The wallet's UTxOs exist only in the wallet. Build transactions from CIP-30 `getUtxos()` and read it again after every `submitTx`, the outputs change. Never build transactions from a chain lookup of the address. Protocol parameters still come from the network, serve them from a recorded file for offline runs.
- Nothing reaches a chain. The wallet's `submitTx` records the transaction, applies it to the wallet's UTxOs and returns the id. `wallet.utxos()` reads the resulting outputs from the test process. A provider or backend that submits must be intercepted with `page.route`, then prove the transaction with `expectSignedBy`.
- A call count proves no signature. Prove it with `expectSignedBy(tx, wallet)` for transactions and `expectSignedData(result, { payload, address })` for messages.
- Wallet errors are plain `{ code, info }` objects as CIP-30 requires. Code that reads `err.message` is a dApp bug the test just found.
- A `ChwError` with code `CHW_UNSUPPORTED_TX_FORM`, `CHW_UNRESOLVED_INPUT` or `CHW_UNRESOLVED_SCRIPT` is a harness diagnosis about the test setup, not wallet behaviour. Follow its hint (add the input to `utxos` or `foreignUtxos`, attach the script or add the UTxO holding it as `scriptRef`, or, for `CHW_UNSUPPORTED_TX_FORM` only, sign with `partialSign: true`) instead of changing the dApp.
- A click does not wait for the wallet. Wait for what the app shows afterwards before you read the journal or `lastSubmittedTx()`.
- The journal (`wallet.calls()`) starts empty after every navigation. Read it before the dApp navigates away, see the login recipe. The ledger behind `wallet.utxos()` lives for the whole test and is not reset by a navigation.
- Reproduce user-side failures with `walletOptions.quirks`, never with a real wallet. Use only the default mnemonic or a throwaway testnet mnemonic, the keys end up in traces.

## Minimal test

```ts
import { test, expect, expectSignedBy } from 'cip30-test-wallet/playwright';

test.use({ walletOptions: { name: 'eternl', networkId: 0, utxos: [{ lovelace: 10_000_000 }] } });

test('pays with a transaction the wallet really signed', async ({ page, wallet }) => {
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  // Wait for what the app shows when the payment went out, the click does not wait for signing.
  await expect(page.getByText('Payment sent')).toBeVisible();

  expect(await wallet.calls('signTx')).toHaveLength(1);
  expectSignedBy((await wallet.lastSubmittedTx())!, wallet);
});
```

`lastSubmittedTx()` holds what the dApp passed to the wallet's `submitTx`. When the dApp submits elsewhere, intercept that request as shown in [docs/recipes.md](docs/recipes.md#a-backend-or-provider-that-submits).
