import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { txHash } from '../src/core/cbor/tx.js';
import { ogmiosCall } from '../src/host/chain/ogmios.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { chainWallet, coinOfBalance, devnetParams, nextBlock, outpoint, settleFee, signAndSubmit, waitSettled, walletOutpoints, type DevnetParams } from './helpers/chain-wallet.js';
import { accountAddress, DEFAULT_LOVELACE_PER_ACCOUNT, genesisTxId, startDevnet, type Devnet } from './helpers/devnet.js';

const RECEIVER = accountAddress(9);
/** How often the follow-up scenario runs before a block that always comes first fails the test. */
const ATTEMPTS = 3;
let devnet: Devnet;
let params: DevnetParams;

beforeAll(async () => {
  devnet = await startDevnet({ name: 'chw-devnet-payment' });
  params = await devnetParams(devnet.ogmiosUrl);
});
afterAll(async () => {
  await devnet?.stop();
});

/** How many of the first count outputs of this transaction the chain holds, asked at Ogmios by output reference. */
async function outputsOnChain(id: string, count: number): Promise<number> {
  const outputReferences = Array.from({ length: count }, (_, index) => ({ transaction: { id }, index }));
  const answer = await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/utxo', { outputReferences });
  if (!('result' in answer) || !Array.isArray(answer.result)) throw new Error(`queryLedgerState/utxo: ${JSON.stringify(answer)}`);
  return answer.result.length;
}

describe('payments through the wallet on the devnet', () => {
  it('signs and submits a follow-up on the change of a payment the chain has not confirmed yet, both confirm, getUtxos agrees with the chain', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 0);
    expect(await walletOutpoints(w)).toEqual([`${bytesToHex(genesisTxId(w.address))}#0`]);
    // Lovelace that left the wallet: payments and fees of every attempt.
    let spent = 0n;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const [funds] = await w.ledger.getWalletUtxos();
      const first = settleFee(params, 1, (fee) =>
        buildTx({
          inputs: [funds!.input],
          outputs: [
            { address: RECEIVER, lovelace: 10_000_000n },
            { address: w.address, lovelace: funds!.lovelace - 10_000_000n - fee },
          ],
          fee,
        }),
      );
      // Right after a block, so about one slot of 1 s is left until the next one.
      await nextBlock(devnet.ogmiosUrl);
      const one = await signAndSubmit(w, first.tx);
      spent += 10_000_000n + first.fee;
      expect(one.id).toBe(bytesToHex(txHash(hexToBytes(one.signed))));
      if ((await outputsOnChain(one.id, 2)) === 0) {
        // The payment waits in the mempool. The wallet shows its change and signs the follow-up against it.
        expect(await walletOutpoints(w)).toEqual([`${one.id}#1`]);
        const change = funds!.lovelace - 10_000_000n - first.fee;
        const second = settleFee(params, 1, (fee) => buildTx({ inputs: [{ txId: hexToBytes(one.id), index: 1n }], outputs: [{ address: w.address, lovelace: change - fee }], fee }));
        const two = await signAndSubmit(w, second.tx);
        spent += second.fee;
        expect(await walletOutpoints(w)).toEqual([`${two.id}#0`]);
        // Still no block with the payment: the node took the follow-up on unconfirmed change.
        if ((await outputsOnChain(one.id, 2)) === 0) {
          await waitSettled(w);
          const onChain = (await w.provider.utxosAt(w.address)).map((u) => outpoint(u.input));
          expect(onChain).toEqual([`${two.id}#0`]);
          expect(await walletOutpoints(w)).toEqual(onChain);
          expect(coinOfBalance(await w.api.getBalance())).toBe(DEFAULT_LOVELACE_PER_ACCOUNT - spent);
          expect((await w.provider.utxosAt(RECEIVER)).map((u) => outpoint(u.input))).toContain(`${one.id}#0`);
          return;
        }
      }
      // A block came first, this attempt proves nothing. The next one starts from what the chain shows.
      await waitSettled(w);
    }
    throw new Error(`in ${ATTEMPTS} attempts a block confirmed the payment before the follow-up was submitted`);
  });

  it('chains three transactions submitted back to back, each on the change of the one before', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [input] = await w.ledger.getWalletUtxos();
      const next = settleFee(params, 1, (fee) => buildTx({ inputs: [input!.input], outputs: [{ address: w.address, lovelace: input!.lovelace - fee }], fee }));
      const { id } = await signAndSubmit(w, next.tx);
      ids.push(id);
      expect(await walletOutpoints(w)).toEqual([`${id}#0`]);
    }
    await waitSettled(w);
    expect((await w.provider.utxosAt(w.address)).map((u) => outpoint(u.input))).toEqual([`${ids[2]}#0`]);
    expect(await walletOutpoints(w)).toEqual([`${ids[2]}#0`]);
  });
});
