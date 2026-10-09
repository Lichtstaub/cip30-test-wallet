import { bech32 } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { ogmiosCall } from '../src/host/chain/ogmios.js';
import { expectSignedBy } from '../src/host/assert.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { chainWallet, cip95Of, devnetParams, nextBlock, settleFee, signAndSubmit, waitSettled, type ChainWallet, type DevnetParams } from './helpers/chain-wallet.js';
import { GENESIS_POOL, nodeContainer, startDevnet, type Devnet } from './helpers/devnet.js';
import { cardanoCliStakeAddressInfo } from './helpers/node-cli.js';

const NAME = 'chw-devnet-stake';
/** How many accounts the overlay scenario tries before a block that always comes first fails the test. */
const ATTEMPTS = 3;

let devnet: Devnet;
let params: DevnetParams;

beforeAll(async () => {
  devnet = await startDevnet({ name: NAME });
  params = await devnetParams(devnet.ogmiosUrl);
});
afterAll(async () => {
  await devnet?.stop();
});

/** The wallet's funds less the deposit and the fee, back to itself, with these certificates. */
function certificateTx(w: ChainWallet, funds: { input: { txId: Uint8Array; index: bigint }; lovelace: bigint }, certificates: unknown[]): string {
  return settleFee(params, 2, (fee) =>
    buildTx({ inputs: [funds.input], outputs: [{ address: w.address, lovelace: funds.lovelace - params.keyDeposit - fee }], fee, extraBodyEntries: new Map([[4n, certificates]]) }),
  ).tx;
}

describe('stake registration on the devnet', () => {
  it('reads a registration with delegation from the overlay while it waits for its block and from the chain after it', async () => {
    for (let account = 0; account < ATTEMPTS; account++) {
      const w = await chainWallet(devnet.ogmiosUrl, account);
      const cip95 = await cip95Of(w);
      expect(await cip95.getRegisteredPubStakeKeys()).toEqual([]);
      expect(await cip95.getUnregisteredPubStakeKeys()).toEqual([w.prepared.stakePublicKeyHex]);

      const [funds] = await w.ledger.getWalletUtxos();
      // stake_reg_deleg_cert = (11, stake_credential, pool_keyhash, coin): registration and delegation to the genesis pool in one
      const register = certificateTx(w, funds!, [[11n, [0n, w.stakeKeyHash], GENESIS_POOL, params.keyDeposit]]);
      // Right after a block, so about one slot of 1 s is left until the next one.
      await nextBlock(devnet.ogmiosUrl);
      const { signed, id } = await signAndSubmit(w, register);
      const fromLedger = await w.ledger.getStakeRegistered();
      const fromChain = await w.provider.stakeRegistered(w.stakeKeyHash);
      const pending = await w.ledger.pendingTxIds();
      expectSignedBy(signed, w.prepared, { roles: ['payment', 'stake'] });

      await waitSettled(w);
      expect(await w.ledger.getStakeRegistered()).toBe(true);
      expect(await cip95.getRegisteredPubStakeKeys()).toEqual([w.prepared.stakePublicKeyHex]);
      // A ledger that never saw the transaction reads the same from the chain.
      const fresh = await chainWallet(devnet.ogmiosUrl, account);
      expect(await fresh.ledger.getStakeRegistered()).toBe(true);
      const answer = await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/rewardAccountSummaries', { keys: [bytesToHex(w.stakeKeyHash)] });
      expect((answer as { result: unknown[] }).result).toEqual([
        expect.objectContaining({
          credential: bytesToHex(w.stakeKeyHash),
          stakePool: { id: bech32.encode('pool', bech32.toWords(GENESIS_POOL)) },
          deposit: { ada: { lovelace: Number(params.keyDeposit) } },
        }),
      ]);

      // Still pending after both reads: the chain did not know the key yet, the overlay did.
      if (pending.includes(id)) {
        expect(fromChain).toBe(false);
        expect(fromLedger).toBe(true);
        return;
      }
      // A block came first, the reads prove nothing about the overlay. The next account tries again.
    }
    throw new Error(`in ${ATTEMPTS} attempts a block confirmed the registration before the wallet read it`);
  });

  it('reads a key registered without any delegation as unregistered, a known limit of the Ogmios provider', async () => {
    // Ogmios 7.0.0 lists a reward account in rewardAccountSummaries only with a pool or DRep delegation,
    // and the reward account summary is the only query probed for a registration alone. A newer Ogmios
    // that lists such keys turns this test red, and the docs on stake registration in chain mode then
    // need an update.
    const w = await chainWallet(devnet.ogmiosUrl, ATTEMPTS);
    const reward = w.prepared.addresses.reward;
    expect(cardanoCliStakeAddressInfo(nodeContainer(NAME), reward)).toEqual([]);
    const [funds] = await w.ledger.getWalletUtxos();
    // reg_cert = (7, stake_credential, coin), the Conway registration with its deposit and no delegation
    await signAndSubmit(w, certificateTx(w, funds!, [[7n, [0n, w.stakeKeyHash], params.keyDeposit]]));
    await waitSettled(w);

    expect(cardanoCliStakeAddressInfo(nodeContainer(NAME), reward)).toEqual([
      expect.objectContaining({ address: reward, stakeRegistrationDeposit: Number(params.keyDeposit), stakeDelegation: null, voteDelegation: null }),
    ]);
    expect(await w.provider.stakeRegistered(w.stakeKeyHash)).toBe(false);
    expect(await w.ledger.getStakeRegistered()).toBe(false);
  });
});
