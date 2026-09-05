import { describe, expect, it } from 'vitest';
import { Transaction } from '@evolution-sdk/evolution';
import { hexToBytes } from '../src/core/bytes.js';
import { expectSignedBy } from '../src/host/assert.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';

describe('expectSignedBy', () => {
  const address = hexToBytes('00' + '11'.repeat(28) + '22'.repeat(28));

  it('passes for a transaction the wallet signed and fails for the unsigned one', async () => {
    const prepared = prepareWallet();
    const target: InstallTarget = {};
    installWallet(prepared.config, target);
    const api = await enableChw(target);
    const utxo = syntheticOwnedUtxo('chw', 0, address, 10_000_000n);
    const unsigned = buildTx({ inputs: [utxo.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
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
    const utxo = syntheticOwnedUtxo('chw', 0, address, 10_000_000n);
    const unsigned = buildTx({ inputs: [utxo.input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
    const signed = Transaction.addVKeyWitnessesHex(unsigned, await api.signTx(unsigned, true));
    expect(() => expectSignedBy(signed, mine)).toThrow(/no valid witness/);
  });
});
