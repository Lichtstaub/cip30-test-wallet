# Lines for your project's agent instructions

Copy these lines into your project's own agent instructions file, such as `AGENTS.md` or `CLAUDE.md`, so a coding agent that changes a wallet flow tests it with cip30-test-wallet.

```md
Wallet flows are tested with cip30-test-wallet (Playwright fixture, import from `cip30-test-wallet/playwright`).
After changing connect, signing or submit code, run the wallet tests and check `wallet.calls()` and `expectSignedBy`.
Reproduce user-side failures with `walletOptions.quirks` (see node_modules/cip30-test-wallet/quirks/README.md), never with a real wallet.
Before writing a transaction test, read node_modules/cip30-test-wallet/AGENTS.md and node_modules/cip30-test-wallet/docs/recipes.md: by default the wallet's UTxOs exist only in the wallet, and anything that submits outside the wallet must be intercepted. This does not hold with `walletOptions.ledger.chain`, where the UTxOs are real and a submit reaches the chain.
Before deploying, run `npx cip30-test-wallet doctor <url> --json` and treat exit code 1 as a failed check.
On macOS, browsers crash at launch inside the agent sandbox. Run the browser tests and `doctor --deep` outside it, or ask for approval for that one command.
```
