# UTxO with a datum hash

**Status:** reported
**Observed:** claimpaign, 2026-03. Evolution SDK's provider `getUtxos()` crashes on UTxOs carrying a reference script (native script outputs from NFT mints). The workaround filters out UTxOs with `dataHash` or `scriptRef`.
**What the wallet does:** there is no switch, it is configuration. `walletOptions.utxos: [{ lovelace, datumHash }]` gives the wallet an owned UTxO with a datum hash, and `getUtxos` returns it as `[address, value, datum_hash]`.
**What breaks:** a dApp path that hands wallet UTxOs with a datum hash unfiltered to an SDK provider.
**How to use:** `test.use({ walletOptions: { utxos: [{ lovelace: 10_000_000 }, { lovelace: 2_000_000, datumHash }] } })`, then drive the flow that reads the wallet's UTxOs.
