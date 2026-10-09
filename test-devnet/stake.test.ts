import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { ogmiosCall } from '../src/host/chain/ogmios.js';
import { expectSignedBy } from '../src/host/assert.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { chainWallet, cip95Of, devnetParams, settleFee, signAndSubmit, waitSettled, type DevnetParams } from './helpers/chain-wallet.js';
import { startDevnet, type Devnet } from './helpers/devnet.js';

let devnet: Devnet;
let params: DevnetParams;

beforeAll(async () => {
  devnet = await startDevnet({ name: 'chw-devnet-stake' });
  params = await devnetParams(devnet.ogmiosUrl);
});
afterAll(async () => {
  await devnet?.stop();
});

describe('stake registration on the devnet', () => {
  it('reads a registration certificate submitted through the wallet back from the chain', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 0);
    const cip95 = await cip95Of(w);
    expect(await cip95.getRegisteredPubStakeKeys()).toEqual([]);
    expect(await cip95.getUnregisteredPubStakeKeys()).toEqual([w.prepared.stakePublicKeyHex]);

    const [funds] = await w.ledger.getWalletUtxos();
    const register = settleFee(params, 2, (fee) =>
      buildTx({
        inputs: [funds!.input],
        outputs: [{ address: w.address, lovelace: funds!.lovelace - params.keyDeposit - fee }],
        fee,
        // reg_cert = (7, stake_credential, coin), the Conway registration with its deposit
        extraBodyEntries: new Map([[4n, [[7n, [0n, w.stakeKeyHash], params.keyDeposit]]]]),
      }),
    );
    const { signed } = await signAndSubmit(w, register.tx);
    expectSignedBy(signed, w.prepared, { roles: ['payment', 'stake'] });
    await waitSettled(w);

    expect(await w.ledger.getStakeRegistered()).toBe(true);
    expect(await cip95.getRegisteredPubStakeKeys()).toEqual([w.prepared.stakePublicKeyHex]);
    // A ledger that never saw the transaction reads the same from the chain.
    const fresh = await chainWallet(devnet.ogmiosUrl, 0);
    expect(await fresh.ledger.getStakeRegistered()).toBe(true);

    const answer = await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/rewardAccountSummaries', { keys: [bytesToHex(w.stakeKeyHash)] });
    expect((answer as { result: unknown[] }).result).toEqual([
      expect.objectContaining({ credential: bytesToHex(w.stakeKeyHash), deposit: { ada: { lovelace: Number(params.keyDeposit) } } }),
    ]);
  });
});
