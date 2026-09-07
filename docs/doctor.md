# doctor

`npx cardano-headless-wallet doctor <url>` checks a deployed dApp for the traps that keep Cardano wallets from injecting.

## Static run

One `fetch`, redirects followed, the final URL is what gets judged.

| Check | Finding | Severity |
|---|---|---|
| Not https and not a loopback host | `no-secure-context` | error |
| No enforced policy | `no-enforced-csp` | info |
| Only a report-only policy | `report-only-csp` | info |
| Enforced `script-src` (or `default-src` as fallback) without `'unsafe-eval'` | `eval-blocked` | warning |
| Enforced policy that does not govern scripts | `eval-unrestricted` | info |
| `'unsafe-inline'` next to a hash or nonce | `inline-hash-conflict` | info |

Every `Content-Security-Policy` header, every comma-separated policy inside one header, and every `<meta http-equiv>` counts. Several enforced policies combine as an intersection. `script-src-elem` and `script-src-attr` never affect the eval verdict.

`eval-blocked` describes the conflict and names the wallets it is confirmed for. It never tells you to add `'unsafe-eval'`. Allowing eval weakens the policy, keeping it excludes the mobile in-app browsers that inject through eval. That is your decision.

## Deep run

`--deep` starts a browser (`--browser chromium|firefox|webkit`, default chromium, needs `@playwright/test` and its browsers) and loads the page twice.

The first load observes. An accessor on `window.cardano` records when the page first reads it and how often, and a listener records the page's own `securitypolicyviolation` events. Nothing is injected.

The second load probes. The eval probe is appended to the response of the first external first-party script, so it runs under the page's real policy. It is skipped, with a reason, when the policy pins scripts by hash, when every first-party script carries an `integrity` attribute, or when there is no external first-party script. The headless wallet is injected (`--inject-after <ms>` delays it), `--click <selector>` runs a user action, and `--expect <selector>` names the element that appears once the dApp detected a wallet.

| Observation | Finding | Severity |
|---|---|---|
| No read of `window.cardano` in the scenario | `no-cip30-access` | info |
| Exactly one read, no retry | `single-scan` | warning |
| Eval probe skipped | `eval-probe-skipped` | info |
| Probe result differs from the policy verdict | `eval-verdict-mismatch` | warning |
| Injected wallet missing from `window.cardano` | `injection-failed` | error |
| `--expect` never visible after injection | `wallet-not-detected` | warning |

Wording is deliberately careful. "No access observed during the executed scenario" is not "this page does not use CIP-30", the page may read `window.cardano` after a click. "Read once" is not "a late wallet is never found", only `--inject-after` with `--expect` proves that.

## Output and exit codes

Human readable by default, `--json` prints the full report. Exit 0 means no finding above info, 1 means at least one warning or error, 2 means the run itself failed (URL unreachable, browser missing).

## Limits

The injected wallet is the default headless wallet, it never signs anything during a doctor run. The deep run cannot reproduce a mobile in-app browser, it measures the page under a desktop engine. WebKit is the closest engine to iOS in-app browsers and enforces the policy on injected code where Chromium and Firefox do not, which is why it is worth running `--browser webkit` for CSP questions.
