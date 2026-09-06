# signRejected

**Status:** confirmed
**Observed:** every wallet. The user cancels the signing prompt.
**What the wallet does:** `signTx()` rejects with `TxSignError` `{ code: 2, info }` (UserDeclined), a plain object.
**What breaks:** flows that show a generic failure or, worse, retry automatically. The right reaction is to tell the user they declined and leave the form as it was.
**How to use:** `test.use({ walletOptions: { quirks: { signRejected: true } } })`, or flip it after connecting with `await wallet.setQuirk('signRejected', true)`.
