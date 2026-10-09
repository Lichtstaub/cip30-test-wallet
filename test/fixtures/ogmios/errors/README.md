# Ogmios submit errors

Answers of `submitTransaction` that refused a transaction, recorded on 2026-10-09. `test/ogmios-errors.test.ts` reads them.

The files named after a code come from a local devnet with cardano-node 11.0.1 at protocol 11 and Ogmios 7.0.0. Each holds the JSON-RPC answer as Ogmios sent it, except `3100-invalid-signatories.json`, which holds only the error object. `koios-invalid-transaction.json` is the answer of the Ogmios that Koios preprod forwards to, for the CBOR `80`, which no era decodes.

| file | transaction |
|---|---|
| `3100-invalid-signatories.json` | a valid key's signature over another body |
| `3101-missing-signatories.json` | a payment input without its witness |
| `3113-script-integrity.json` | a Plutus spend with an all zero script integrity hash |
| `3117-unknown-output-references.json` | an unknown input, a 10 lovelace fee, no balance and no witness at once |
| `3118-outside-validity-interval.json` | a TTL of slot 1 submitted at slot 4 |
| `3122-fee-too-small.json` | a fee of 1000 lovelace |
| `3123-value-not-conserved.json` | outputs worth more than the input |
| `3124-network-mismatch.json` | an output to a mainnet address |
| `3125-insufficiently-funded-outputs.json` | an output of 1000 lovelace |
| `3134-execution-units-too-large.json` | a redeemer above the transaction ExUnits limit |
| `3136-failed-unexpectedly.json` | an always failing V3 script with is_valid true |
| `3136-passed-unexpectedly.json` | an always succeeding V3 script with is_valid false |
| `3997-all-inputs-spent.json` | the same transaction twice, every input already spent |

`cardano-cli.json` holds the first error line `cardano-cli conway transaction submit` printed for the same cases, inside the node container of the same devnet, cardano-node 11.0.1 at protocol 11.
