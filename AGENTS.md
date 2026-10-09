# cip30-test-wallet for coding agents

This package injects a CIP-30 Cardano wallet into a page under Playwright. It connects, signs and answers without a popup, so an agent can test a dApp's wallet flows unattended and check its own changes.

## Where to look

| Task | File |
|---|---|
| Adding the wallet to an existing dApp step by step, logins with `signData` | [README.md](README.md#getting-started) |
| Every `walletOptions` field and `wallet` handle member | [docs/fixture-api.md](docs/fixture-api.md) |
| Playwright code without the test runner | [README.md](README.md#agents-that-drive-the-browser-themselves) (`attachWallet`) |
| Building and submitting transactions with Evolution SDK, Mesh or Lucid Evolution, backends that submit, offline protocol parameters, node rejections with the ledger checks, user-side failures, the journal | [docs/recipes.md](docs/recipes.md) |
| Every rule the ledger checks know, what stays unchecked, where the wallet differs from a node | [README.md](README.md#ledger-checks) |
| Real UTxOs and real submits against a devnet, preprod or mainnet | [README.md](README.md#chain-mode), [docs/recipes.md](docs/recipes.md#testing-against-a-local-devnet) |
| Reproducing a specific wallet or user behaviour | [quirks/README.md](quirks/README.md) |
| A browser driven through Playwright MCP instead of a test file | [docs/init-script.md](docs/init-script.md) |
| Checking a deployed dApp for CSP and detection problems | [docs/doctor.md](docs/doctor.md) |
| A library that misbehaves against a spec-conformant wallet | [docs/known-consumer-issues.md](docs/known-consumer-issues.md) |

In an installed project these files are under `node_modules/cip30-test-wallet/`.

## Rules that save a debugging round

- Import `test`, `expect`, `expectSignedBy`, `expectSignedData` and `attachWallet` from `cip30-test-wallet/playwright`, not from `@playwright/test`.
- By default the wallet's UTxOs exist only in the wallet. Build transactions from CIP-30 `getUtxos()` and read it again after every `submitTx`, the outputs change. Never build transactions from a chain lookup of the address, unless the test runs in chain mode (below). Protocol parameters still come from the network, serve them from a recorded file for offline runs.
- By default nothing reaches a chain. The wallet's `submitTx` records the transaction, applies it to the wallet's UTxOs and returns the id. `wallet.utxos()` reads the resulting outputs from the test process. A provider or backend that submits must be intercepted with `page.route`, then prove the transaction with `expectSignedBy`. In chain mode `submitTx` submits for real.
- A call count proves no signature. Prove it with `expectSignedBy(tx, wallet)` for transactions and `expectSignedData(result, { payload, address })` for messages.
- Wallet errors are plain `{ code, info }` objects as CIP-30 requires. Code that reads `err.message` is a dApp bug the test just found.
- A `ChwError` with code `CHW_UNSUPPORTED_TX_FORM`, `CHW_UNRESOLVED_INPUT` or `CHW_UNRESOLVED_SCRIPT` is a harness diagnosis about the test setup, not wallet behaviour. Follow its hint (add the input to `utxos` or `foreignUtxos`, attach the script or add the UTxO holding it as `scriptRef`, or, for `CHW_UNSUPPORTED_TX_FORM` only, sign with `partialSign: true`) instead of changing the dApp. In chain mode the hints about `utxos` and `foreignUtxos` do not apply, see below.
- With `walletOptions.ledger: { checks: true }` a refused `submitTx` is wallet behaviour: a plain `{ code: 2, info }` whose `info` names the node's rules, such as `FeeTooSmallUTxO`, or `ValidationTagMismatch` when a Plutus script fails, needs more ExUnits than its redeemer declares, or every script passes while `is_valid` is false (`PassedUnexpectedly`). Fix the transaction or the dApp's error display. A `CHW_UNSUPPORTED_TX_FORM` from `submitTx` is still a harness diagnosis, run that test without the checks. `CHW_EVALUATOR_UNAVAILABLE` means the Plutus evaluator that comes with the package could not be loaded, reinstall the package. `CHW_EVALUATOR_FAILED` means the evaluator stopped on this transaction without a failing script, its message says why. Run that test without the checks.
- A click does not wait for the wallet. Wait for what the app shows afterwards before you read the journal or `lastSubmittedTx()`, which also returns a `submitTx` that is still running.
- The journal (`wallet.calls()`) starts empty after every navigation. Read it before the dApp navigates away, see the login recipe. The ledger behind `wallet.utxos()` lives for the whole test and is not reset by a navigation.
- Reproduce user-side failures with `walletOptions.quirks`, never with a real wallet. Use only the default mnemonic or a throwaway testnet mnemonic, never one that holds real funds, the keys end up in traces.
- On macOS, Playwright browsers cannot start inside an agent sandbox such as Codex `--sandbox workspace-write`. Every engine aborts at launch without window server access, Playwright reports only a closed browser, and each abort opens a crash dialog on the user's screen. Run browser tests and `doctor --deep` outside the sandbox or with your escalation. `doctor --deep` detects the Codex sandbox and stops before launching.

## Chain mode

- `walletOptions.ledger: { chain: { provider: 'ogmios', url } }` points the wallet at a devnet or a node of your own, `{ chain: { provider: 'koios', network: 'preprod' } }` at a public network. UTxOs and stake registration then come from that chain and `submitTx` submits. It does not combine with `utxos`, `foreignUtxos`, `stakeRegistered`, `ledger.state: false`, `ledger.checks: true` or the options that only apply with the checks, `prepareWallet` names the conflict. `init-script` refuses it.
- A refused `submitTx` is the chain's answer, `{ code: 2, info }` with one rule name in `info`, or `Ogmios <code>: <message>` for a refusal the wallet cannot map to a rule. Fix the transaction or the dApp's error display.
- `CHW_CHAIN_UNAVAILABLE` is a harness diagnosis: the provider could not be reached or answered with something unexpected. Check the URL and whether the devnet runs, then retry.
- `CHW_MAINNET_LOCKED` means the test signs a transaction on mainnet. Only `signTx` is locked, `signData` and `submitTx` still work there. Run that flow on a testnet. Set `allowMainnetSigning: true` only when a human decided that this test may move real funds.
- Tests on one chain with one mnemonic share their UTxOs. Give each test file its own `accountIndex`, or run them with one worker. Under `fullyParallel: true` add `test.describe.configure({ mode: 'serial' })` to a file whose tests spend.
- `CHW_UNRESOLVED_INPUT` in chain mode means the chain does not show that input unspent: spent elsewhere or never created. Rebuild the transaction from `getUtxos()`. `CHW_UNRESOLVED_SCRIPT` in chain mode means the transaction neither attaches the script nor names the UTxO holding it as a reference input. Ignore the hint about `utxos` and `foreignUtxos`, chain mode refuses both.
- On a public network use a throwaway testnet mnemonic of your own. The default one is public, its preprod address holds UTxOs other people sent there, and `getUtxos` shows them.
- Pass a mnemonic with test funds or a provider token through an environment variable, never commit it.

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
