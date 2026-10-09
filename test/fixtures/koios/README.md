# Koios answers

Answers of the public Koios preprod instance at `https://preprod.koios.rest/api/v1`, recorded without a token on 2026-10-09. `test/koios.test.ts` serves them through a fake `fetch`. No valid transaction was sent.

| file | request |
|---|---|
| `address_utxos-script.json` | `POST /address_utxos` with `_extended: true` for two script addresses whose outputs carry inline datums, reference scripts and native assets |
| `address_utxos-wallet.json` | the same for a key address with three outputs, one holding a native asset |
| `utxo_info-mixed.json` | `POST /utxo_info` with `_extended: true` for an unspent output with a datum hash and a reference script, a spent output and an outpoint that never existed (missing from the answer) |
| `account_info.json` | `POST /account_info` for a registered and an unregistered stake address |
| `account_info-unknown.json` | the same for a stake address never seen on chain |
| `tx_cbor.json` | `POST /tx_cbor` for the transactions that created the outputs above, to compare datum and script bytes |
| `ogmios-genesis-shelley.json` | `POST /ogmios` `queryNetwork/genesisConfiguration` with `era: shelley` |
| `ogmios-submit-invalid.json` | `POST /ogmios` `submitTransaction` with the CBOR `80`, HTTP 400 |
| `ogmios-submit-unknown-input.json` | `POST /ogmios` `submitTransaction` with the unsigned transaction in `ogmios-submit-unknown-input.tx.hex`, whose only input never existed, HTTP 400 |
| `error-postgrest-bad-arg.json` | `POST /address_utxos` with a string for `_addresses`, HTTP 400 |
| `error-payload-too-large.txt` | `POST /utxo_info` with a body over 5120 bytes, HTTP 413 |
| `error-not-found.txt` | an unknown path, HTTP 404 |
| `error-bad-token.txt` | a request with an invalid bearer token, HTTP 403 |
| `error-ogmios-unknown-method.txt` | `POST /ogmios` with a method Koios does not forward, HTTP 403 |
| `tip.json` | `GET /tip`, the block at the tip of the chain |

`ogmios-submit-accepted.json` is the answer of Ogmios 7.0.0 on a local devnet to an accepted `submitTransaction`, the shape the Ogmios behind `/ogmios` sends.
