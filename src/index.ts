// Public API of the main entry, the part README and docs describe. Everything
// else under src is internal and can change in any release. Tests and repo
// scripts import internals by path.
export { DEFAULT_MNEMONIC, prepareWallet } from './host/config.js';
export type { PreparedWallet, WalletOptions } from './host/config.js';
export { initScript } from './host/bundle.js';
export { expectSignedBy, expectSignedData } from './host/assert.js';
export type { SignedDataExpectation, SignerRole } from './host/assert.js';
export { APIErrorCode, ChwError, DataSignErrorCode, TxSignErrorCode } from './core/errors.js';
export type { ChwErrorCode, Cip30Error } from './core/errors.js';
export { QUIRK_NAMES } from './page/config.js';
export type { JournalEntry, PageConfig, QuirkConfig, QuirkName } from './page/config.js';
