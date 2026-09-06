import { describe, expect, it } from 'vitest';
import { Transaction } from '@evolution-sdk/evolution';
import { expectSignedBy } from '../src/host/assert.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { standardUnsignedTx } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';

describe('expectSignedBy', () => {
  it('passes for a transaction the wallet signed and fails for the unsigned one', async () => {
    const prepared = prepareWallet();
    const target: InstallTarget = {};
    installWallet(prepared.config, target);
    const api = await enableChw(target);
    const unsigned = standardUnsignedTx('chw');
    const signed = Transaction.addVKeyWitnessesHex(unsigned, await api.signTx(unsigned, false));
    expect(() => expectSignedBy(signed, prepared)).not.toThrow();
    expect(() => expectSignedBy(unsigned, prepared)).toThrow(/no valid witness/);
  });

  it('fails when the witness belongs to another wallet', async () => {
    const mine = prepareWallet();
    const other = prepareWallet({ accountIndex: 1 });
    const target: InstallTarget = {};
    installWallet(other.config, target);
    const api = await enableChw(target);
    const unsigned = standardUnsignedTx('chw');
    const signed = Transaction.addVKeyWitnessesHex(unsigned, await api.signTx(unsigned, true));
    expect(() => expectSignedBy(signed, mine)).toThrow(/no valid witness/);
  });
});
