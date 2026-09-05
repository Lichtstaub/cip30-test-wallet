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

Bundle check (`npm run bundle:check`): fail. Sizes were sign-tx.js 91.8 KB, ledger.js 22.5 KB, addresses.js 12.3 KB, all well under the 120 KB limit and free of WebAssembly and unresolved external imports. The check still fails because its Buffer detection regex also matches the substring inside `ArrayBuffer.isView`, a call the allowed dependency `@scure/base` uses internally. No file in `src/core` imports outside the allowed set (`@noble/curves`, `@noble/hashes`, `@scure/base`, `src/core`), and no actual Node `Buffer` is referenced anywhere in the bundles.

Decision: open. Tests and typecheck are fully green and the bundles carry no real Node, WASM or external dependency, but the bundle check as written reports a false failure on `ArrayBuffer.isView` and needs a decision on how to refine it before milestone 2 starts on a clean signal.
