# enableRejected

**Status:** confirmed
**Observed:** every wallet. The user closes the connect dialog or clicks deny.
**What the wallet does:** `enable()` rejects with `APIError` `{ code: -3, info }` (Refused). `isEnabled()` stays `false`.
**What breaks:** dApps that treat any `enable()` failure as "wallet broken", or that read `err.message` from a plain object and show `undefined`.
**How to use:** `test.use({ walletOptions: { quirks: { enableRejected: true } } })`.
