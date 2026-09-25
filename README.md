# cardano-headless-wallet

`cardano-headless-wallet` reproduces real Cardano wallet failures in automated browser tests, with no node, faucet, extension, or shared chain state.

It injects a headless CIP-30 wallet into the page under test. The wallet holds real keys, returns real UTxO CBOR, signs real transaction CBOR with a real Ed25519 signature, and records every call in a journal your test can read. A catalogue of quirks reproduces the failures that only show up on a user's machine: a wallet on the wrong network, a wallet that injects late, a user who declines or never answers.

**Status: pre-release.** Milestone 2b. The signing core, the Playwright fixture and the `doctor` command work end to end against the demo dApp in this repository. Not yet on npm. Not yet supported: `getCollateral`, native assets.

## What is in the box

- A CIP-30 provider for the page: `apiVersion`, `name`, `icon`, `supportedExtensions`, `enable`, `isEnabled`, and the api methods `getNetworkId`, `getUtxos` (with `amount` and `paginate`), `getBalance`, `getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`, `getRewardAddresses`, `getExtensions`, `signTx`, `submitTx`.
- A Playwright fixture: `test.use({ walletOptions })` configures the wallet, `wallet` in the test reads the journal and flips quirks at runtime.
- `expectSignedBy(txHex, wallet)`: proves the transaction your dApp submitted really carries the wallet's signature over its body hash. Recording `submitTx` alone proves nothing.
- Five quirks with provenance notes in [`quirks/`](quirks/README.md).
- `doctor`: a command line check of a deployed dApp for the secure-context and content-security-policy traps, with a browser mode that measures wallet detection.

## Not in the box yet

This release is a CIP-30 subset for transaction tests. Missing on purpose, tracked for later milestones: `getCollateral`, native assets in balances and UTxOs, script inputs, certificates, and every transaction form outside the supported set below. `submitTx` is simulated: it records the transaction and returns its id, it never talks to a node. Fees, validity and script execution are not checked.

`signData` follows CIP-30 and CIP-8 byte for byte with Emurgo's message-signing library: payment key for base and enterprise addresses, stake key for reward addresses. CIP-95 is announced by default: `getPubDRepKey`, the registered and unregistered stake keys, and `cip95.signData` with the bare DRep ID or a type 6 address. Governance transactions (certificates, votes, proposals) are not signed yet.

## Quick start

```ts
// tests/commit.spec.ts
import { test, expect, expectSignedBy } from 'cardano-headless-wallet/playwright';

test.use({ walletOptions: { name: 'eternl', networkId: 0, utxos: [{ lovelace: 10_000_000 }] } });

test('commit writes the expected metadata', async ({ page, wallet }) => {
  await page.goto('/commit');
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Commit' }).click();

  expect(await wallet.calls('signTx')).toHaveLength(1);
  const tx = await wallet.lastSubmittedTx();
  expectSignedBy(tx!, wallet);
});
```

Reproduce a wrong-network user in one line:

```ts
test.use({ walletOptions: { networkId: 1 } });   // wallet on mainnet, your dApp expects preprod
```

Reproduce a user who never answers the signing prompt, and let them answer when your assertion is done:

```ts
test.use({ walletOptions: { quirks: { signHangs: true } } });
await page.getByRole('button', { name: 'Commit' }).click();
await expect(page.getByText('Waiting for your wallet')).toBeVisible();
await wallet.release('signTx');
```

The full option and handle reference is in [docs/fixture-api.md](docs/fixture-api.md).

## Keys and secrets

The wallet's extended private keys are serialised into the page's init script by design, that is how a headless CIP-30 provider signs without a node process to call back into. So they appear in Playwright traces, HAR files and any dump of the page. Use only throwaway mnemonics for tests, never one that holds real funds. The default mnemonic is the public CSL test vector and holds no funds.

## Defaults are spec-conformant, not convenient

Errors are plain `{ code, info }` objects, as CIP-30 requires, never `Error` instances. Code that reads `err.message` shows up immediately. `getUtxos()` returns `[]` for an empty wallet and `null` when the requested amount cannot be reached. Addresses are hex CBOR bytes. A test that is green with the defaults already tells you something.

## Supported transaction forms

The wallet decides what to sign for these body fields: inputs at key addresses, `required_signers`, withdrawals, plus outputs, fee, ttl, validity start, auxiliary data hash and network id. A requirement it does not own must already be covered by a valid witness in the transaction (multi-party flows), otherwise `signTx` refuses with `TxSignError` ProofGeneration. Anything else (script inputs, certificates, mint, collateral, governance fields, unknown keys) raises a harness diagnosis `ChwError` with code `CHW_UNSUPPORTED_TX_FORM` at `partialSign: false`. A harness diagnosis is never disguised as a wallet error. An input the mock ledger does not know raises `CHW_UNRESOLVED_INPUT` with a hint to add it to `utxos` or `foreignUtxos`.

Evolution SDK always calls `signTx(cbor, true)`, so with Evolution the form check above never refuses. The wallet signs only its own share and logs a `console.warn` naming every skipped form instead.

## Known consumer issues

A consumer SDK expecting real-wallet behaviour can still misbehave against a spec-conformant wallet. See [docs/known-consumer-issues.md](docs/known-consumer-issues.md), currently one entry: Evolution SDK's `cip30Wallet(api).rewardAddress()` rejects the hex-encoded reward address CIP-30 requires.

## The demo dApp

`examples/minimal-dapp` is a framework-free page served under a strict and a permissive Content Security Policy. It scans `window.cardano`, connects, checks the network, signs and submits a fixed transaction. `npm run serve:demo` starts it on port 4173, `npm run test:browser` runs the browser suite against it in Chromium, Firefox and WebKit.

## doctor

```bash
npx cardano-headless-wallet doctor https://your-dapp.example
npx cardano-headless-wallet doctor https://your-dapp.example --deep --browser webkit --click '#connect' --expect '#wallet-found' --settle 3000
```

Static: secure context, every content security policy in headers and meta tags, and whether the effective script policy blocks `eval`, which is how mobile wallet in-app browsers inject. Deep: when the page reads `window.cardano` and whether it retries, whether the policy really blocks `eval` inside a first-party script, and whether an injected wallet, optionally a late one, is detected. Exit 0 clean, 1 findings, 2 run failed. Details in [docs/doctor.md](docs/doctor.md).

## Development

```bash
npm install
npx playwright install chromium firefox webkit
npm test              # core and page tests in Node
npm run typecheck
npm run build         # dist/node and dist/page.js
npm run test:browser  # builds first, then Playwright in three engines
npm run bundle:check  # the page bundle must stand alone: no Node, no WASM, no externals
```

Related work: [cardano-test-wallet](https://github.com/cardanoapi/cardano-test-wallet) (MIT) is the conceptual predecessor, a simulated wallet built for GovTool. Sorbet and Cardano Dev Wallet are browser extensions for manual testing. This project targets CI.

## Spike results

The two tables below record the milestone 1 and 1b spikes that this release is built on.

## Milestone 1 exit criteria

| # | Criterion | Test | Result |
|---|---|---|---|
| 1 | Body slice and Blake2b-256 match Evolution byte for byte | `test/tx-hash.test.ts` | pass |
| 2 | Witness set accepted by Evolution, signature verifies | `test/witness.test.ts` | pass |
| 3 | Mnemonic restore matches CSL, Evolution and the documented vector, signatures byte identical | `test/keys.test.ts`, `test/derive.test.ts` | pass |
| 4 | Evolution merges our witness set without losing foreign witnesses, and a party that already signed counts as coverage | `test/witness.test.ts`, `test/sign-tx.test.ts` | pass |
| 5 | Supported forms only: own key signs, uncovered foreign key refuses, script inputs, certificates and unknown inputs raise a harness diagnosis | `test/sign-tx.test.ts` | pass |
| 6 | submitTx returns the transaction id Evolution computes | `test/submit.test.ts` | pass |

Typecheck (`npm run typecheck`): pass, no errors. All 52 tests pass.

Bundle check: sign-tx.js 91.8 KB, ledger.js 22.5 KB, addresses.js 12.3 KB (no Node, no WASM, no externals).

Decision: the WASM-free core is viable. Milestone 2 builds the CIP-30 surface on it.

## Milestone 1b exit criteria (browser and CSP)

| # | Criterion | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| 1 | Page-native eval blocked under strict CSP, allowed under permissive | pass | pass | pass |
| 2a | addInitScript eval probe agrees with page-native verdict | bypass (strict) | bypass (strict) | pass |
| 2b | page.evaluate eval probe agrees with page-native verdict | bypass (strict) | bypass (strict) | bypass (strict) |
| 2c | securitypolicyviolation observable from an init script | pass | pass | pass |
| 2d | Probe appended to the first-party script via response interception agrees with page-native verdict | pass | pass | pass |
| 3 | Injected stub wallet visible and usable under strict CSP | pass | pass | pass |
| 4 | Late injection (800 ms) missed without retry, found with retry | pass | pass | pass |

Consequence for `doctor --deep`: row 2a is dropped as a probe path, it bypasses the strict CSP in Chromium and Firefox and would report `ok` where the page itself is blocked. Row 2b is dropped as a probe path too, it bypasses the strict CSP in all three engines. Row 2c stays, but only as an observation of the page's own `securitypolicyviolation` events, not as an injected probe. Once the route-appended probe (2d) is active, the violation observer also sees the eval probe's own violation, attributed to the site's own script file, so violation observation and the eval probe must run on separate loads or be filtered by the appended offset, they are not independent evidence in one run. Row 2d becomes the eval probe path, appending the probe to a first-party script through response interception runs it under the page's real CSP and agrees with the page-native verdict everywhere, with the limitation that the probe needs an external first-party script that is not hash-pinned in the policy and carries no SRI `integrity` attribute. On a hash-pinned CSP or an SRI-protected script, appending breaks the page's own script entirely (verified in all three engines), so doctor must detect both cases first and fall back to the static verdict with an explicit reason. Inline-only pages give no verdict at all. Verified to work with `script-src 'self'`, a nonce-only policy and a gzipped response.

Consequence for the fixture: the fixture does not reproduce the CSP trap (row 3), that remains the doctor's job. In the other direction, WebKit does enforce CSP on init-script code (row 2a), so a fixture bundle that contains `eval` or `new Function`, from the core or a dependency, is blocked in WebKit under a strict policy while it keeps working in Chromium and Firefox. The bundle check rejects both.
