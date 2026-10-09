# Ogmios answers

JSON-RPC answers the Ogmios client is tested against. The `v7-*` files come from Ogmios 7.0.0 on cardano-node 11.0.1, the `v6-*` files from Ogmios 6.14.0 on cardano-node 10.5.1, both on a local devnet with throwaway keys (network magic 42). They are stored as Ogmios sent them, apart from indentation.

| File | Request |
| --- | --- |
| `v7-utxo-by-address.json`, `v6-utxo-by-address.json` | `queryLedgerState/utxo` with `addresses`, one genesis output of a base address |
| `v7-utxo-by-ref.json` | `queryLedgerState/utxo` with `outputReferences`, an enterprise and a base address output |
| `v7-reward-registered.json`, `v6-reward-registered.json` | `queryLedgerState/rewardAccountSummaries` with `keys`, a registered stake key |
| `v7-reward-unregistered.json`, `v6-reward-unregistered.json` | the same for a stake key that is not registered |
| `v7-genesis-shelley.json`, `v6-genesis-shelley.json` | `queryNetwork/genesisConfiguration` with `era: "shelley"` |
| `v7-submit-ok.json` | `submitTransaction`, accepted |
| `v7-submit-fee-too-small.json` | `submitTransaction`, refused with 3122 |
| `v6-submit-bad-inputs.json` | `submitTransaction`, refused with 3117 |

Two files are built by hand, because no recorded answer has these shapes:

- `v7-utxo-full.json` follows the `Utxo` schema of Ogmios 7 (`cardano.json`): lovelace and asset quantities above 2^53 written as raw integers, an inline datum, a datum hash, a Plutus V3 reference script (the `v3_always_succeeds` script of `../plutus/scripts.json`) and native reference scripts with and without `cbor`.
- `v6-reward-map.json` is the map form of `rewardAccountSummaries` that Ogmios returned before 6.13 (release notes of 6.13: "now returns a list of results instead of a map").
