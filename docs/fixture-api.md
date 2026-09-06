# Fixture reference

## `test.use({ walletOptions })`

| Option | Default | Meaning |
|---|---|---|
| `name` | `'chw'` | Key under `window.cardano` |
| `displayName` | `'Headless Wallet'` | CIP-30 `name` |
| `icon` | `''` | CIP-30 `icon` |
| `networkId` | `0` | `0` testnets, `1` mainnet. Addresses follow it |
| `mnemonic` | public CSL test vector | CIP-1852 account source. Never use a funded mnemonic, the keys end up in the page and in Playwright traces |
| `accountIndex` | `0` | CIP-1852 account |
| `install` | `true` | Set `false` to skip injecting the provider. `name`, `addresses`, `paymentPublicKeyHex` and `stakePublicKeyHex` still work, every other handle member rejects |
| `utxos` | `[{ lovelace: 10_000_000 }]` | Owned outputs, in order. Ids are deterministic per name and position |
| `foreignUtxos` | `[]` | Outputs the ledger knows but does not own, for multi-party transactions |
| `quirks` | `{}` | See the quirk catalogue |

## `wallet` handle

The wallet is an automatic fixture: it is installed for every test in a file that imports this `test`, whether or not the test destructures `wallet`.

| Member | Type | Meaning |
|---|---|---|
| `name` | `string` | The `window.cardano` key |
| `addresses.payment`, `addresses.reward` | `string` | bech32 |
| `paymentPublicKeyHex`, `stakePublicKeyHex` | `string` | Raw 32-byte public keys |
| `calls(method?)` | `Promise<JournalEntry[]>` | Journal, optionally filtered |
| `lastSubmittedTx()` | `Promise<string \| undefined>` | Hex CBOR handed to `submitTx` |
| `setQuirk(name, value)` | `Promise<void>` | Flip a quirk at runtime. Rejects with `InvalidRequest` for an unknown quirk name, and for `lateInjection` after install, it only applies at install time through `walletOptions.quirks` |
| `release('signTx')`, `reject('signTx')` | `Promise<number>` | End a hanging `signTx`, resolving to how many calls it settled. Nothing pending resolves to `0` |

A `JournalEntry` is `{ method, args, result?, error?, t }`. Results of `enable` are journaled as `'[api]'`. Key material never appears in the journal.

## State lives in the page

The journal and every `setQuirk` change live in the page, not in the test process. Each navigation resets both to the wallet's initial configuration. Read `wallet.calls()` before navigating away from the page you want to assert on, not after.

## `expectSignedBy(txHex, wallet)`

Throws unless `txHex` carries a vkey witness whose key is the wallet's payment key and whose signature verifies over the transaction's body hash. Use it on `await wallet.lastSubmittedTx()`.

## Errors

CIP-30 errors are plain objects: `APIError` `{ code: -1 | -2 | -3 | -4, info }`, `TxSignError` `{ code: 1 | 2, info }`, `PaginateError` `{ maxSize }`. Harness diagnoses are `ChwError` instances with `code` `CHW_UNRESOLVED_INPUT` or `CHW_UNSUPPORTED_TX_FORM`. Decoding failures become `APIError` InvalidRequest.
