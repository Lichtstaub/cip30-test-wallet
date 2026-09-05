# cardano-headless-wallet

Headless CIP-30 wallet for automated Cardano dApp tests.

**Status: milestone 1 spike.** This repository currently proves that a WASM-free
signing core produces transactions that Evolution SDK and CSL accept byte for
byte. Nothing here is published or usable yet. See the exit criteria table at
the bottom once the spike is complete.

Conceptual predecessor: [cardano-test-wallet](https://github.com/cardanoapi/cardano-test-wallet) (MIT).

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
| 2a | addInitScript eval probe agrees with page-native verdict | bypass | bypass | pass |
| 2b | page.evaluate eval probe agrees with page-native verdict | bypass | bypass | bypass |
| 2c | securitypolicyviolation observable from an init script | pass | pass | pass |
| 2d | Probe appended to the first-party script via response interception agrees with page-native verdict | pass | pass | pass |
| 3 | Injected stub wallet visible and usable under strict CSP | pass | pass | pass |
| 4 | Late injection (800 ms) missed without retry, found with retry | pass | pass | pass |

Consequence for `doctor --deep`: row 2a is dropped as a probe path, it bypasses the strict CSP in Chromium and Firefox and would report `ok` where the page itself is blocked. Row 2b is dropped as a probe path too, it bypasses the strict CSP in all three engines. Row 2c stays, but only as an observation of the page's own `securitypolicyviolation` events, not as an injected probe. Row 2d becomes the eval probe path, appending the probe to a first-party script through response interception runs it under the page's real CSP and agrees with the page-native verdict everywhere, with the limitation that the page needs at least one first-party script to append it to.

Consequence for the fixture: the fixture does not reproduce the CSP trap (row 3), that remains the doctor's job.
