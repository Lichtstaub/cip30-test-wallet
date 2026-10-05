# Plutus test scripts

Real compiled Plutus scripts for the tests. `scripts.json` lists each one with `name`, `language` (`PlutusV1`, `PlutusV2` or `PlutusV3`), `hash`, `cborHex` and `origin`. `test/helpers/plutus-fixtures.ts` reads the file, `test/plutus-fixtures.test.ts` recomputes every hash from the bytes.

`cborHex` is the script the way the witness set and the `compiledCode` of an aiken blueprint carry it: one CBOR byte string around the flat encoded program. The script hash is blake2b-224 over the language tag (1, 2 or 3) followed by these bytes. The `cborHex` of a cardano-cli `.plutus` file wraps them once more, the V1 and V2 entries are the inner byte string of such a file.

| name | what it does |
|---|---|
| `v3_always_succeeds` | accepts every purpose |
| `v3_always_fails` | fails every purpose |
| `v3_always_fails_traced` | fails every purpose and logs `oracle: always fails` |
| `v3_needs_signer` | spends when the inline datum is a key hash among the required signers |
| `v3_after_deadline` | spends when the validity range starts at or after the inline datum, a POSIX time in ms |
| `v3_burn` | counts down from the integer redeemer, for a known budget |
| `v3_two_args` | `\_ -> \_ -> ()`, fails every run under Plutus V3 (CIP-117 needs unit back) |
| `v2_always_succeeds`, `v1_always_succeeds` | accept every spend, from cardano-node `scripts/plutus/scripts` |

## Rebuilding the aiken scripts

The V3 scripts except `v3_two_args` come from `oracle.ak`, compiled with aiken v1.1.21 and stdlib v2.2.0. stdlib v4 does not compile with this aiken. In an empty folder, with `REPO` set to the repository root:

```sh
mkdir validators
cp "$REPO/test/fixtures/plutus/oracle.ak" validators/
cat > aiken.toml <<'EOF'
name = "fixtures/oracle"
version = "0.0.0"
compiler = "v1.1.21"
plutus = "v3"

[[dependencies]]
name = "aiken-lang/stdlib"
version = "v2.2.0"
source = "github"
EOF
aiken build
aiken build -t verbose -f user-defined -o plutus-traced.json
```

`plutus.json` then holds every validator without traces, `compiledCode` is `cborHex` and `hash` is `hash` in `scripts.json`. The traced build changes `always_fails`, `needs_signer` and `after_deadline`. Only the traced `always_fails` is a fixture, as `v3_always_fails_traced`.
