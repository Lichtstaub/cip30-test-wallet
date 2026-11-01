# Security policy

## Reporting a vulnerability

Report it privately through a [GitHub security advisory](https://github.com/Lichtstaub/cip30-test-wallet/security/advisories/new). Please do not open a public issue for it.

## Supported versions

Only the latest minor release receives fixes.

## Scope

cip30-test-wallet is a wallet for tests. Its private keys sit in the init script, in Playwright traces and in test output by design, and that is not a vulnerability. Use test mnemonics only.

A vulnerability is any way in which `signTx` signs a mainnet transaction in chain mode without `allowMainnetSigning: true`. The offline mode has no mainnet lock, so offline signatures with `networkId: 1` are documented behavior and not a finding. The same holds for `signData` and `submitTx` in chain mode, which the lock does not cover.
