# Known consumer issues

Bugs in a consumer SDK that surface against this wallet because it is spec-conformant, not because it misbehaves. Real wallets trip the same bug.

## Evolution SDK: `cip30Wallet(api).rewardAddress()` rejects the hex-encoded reward address CIP-30 requires

**What CIP-30 says.** The Address data type is a bech32 or hex string on input, but every value the API returns "must return the hex-encoded bytes format" (CIP-30, Data Types, Address). `getRewardAddresses()` returns `Address[]`, so its entries are hex, not bech32.

**What Evolution does.** Evolution SDK 0.5.x, `sdk/client/internal/Wallets.js`, decodes the reward address bech32 only inside `rewardAddress()`, while the neighbouring `getUsedAddresses` path already carries a bech32-then-hex fallback. Handed the hex string CIP-30 mandates, the bech32 decoder throws.

**How to reproduce with this wallet.**

```ts
import { test } from 'cardano-headless-wallet/playwright';
// inside a page under test, with the CIP-30 provider installed by the fixture:
// api.getRewardAddresses() returns hex, cip30Wallet(api).rewardAddress() throws
```

Connect through Evolution's `cip30Wallet` helper against any wallet installed by this fixture (default options are enough) and call `.rewardAddress()`. It throws on the hex string this wallet, and any spec-conformant wallet, returns.

**Status.** Reported upstream: not yet.
