import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { encodeOutput, type Utxo } from '../src/core/ledger.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { rejectionOf } from '../test/helpers/page.js';
import { plutusScript } from '../test/helpers/plutus-fixtures.js';
import { inlineDatum, plutusSpend, UNIT_DATA } from '../test/helpers/plutus-spend.js';
import { scriptAddress } from '../test/helpers/synthetic.js';
import { addWalletWitnesses, chainWallet, devnetParams, settleFee, signAndSubmit, waitSettled, walletOutpoints, type ChainWallet, type DevnetParams } from './helpers/chain-wallet.js';
import { accountAddress, nodeContainer, startDevnet, type Devnet } from './helpers/devnet.js';
import { cardanoCliSubmit, headFailure } from './helpers/node-cli.js';

const NAME = 'chw-devnet-rejection';
const EX_UNITS = { mem: 100_000n, steps: 10_000_000n };
const always = plutusScript('v3_always_succeeds');
const SCRIPT_ADDRESS = scriptAddress(always.hash);

describe('headFailure', () => {
  it('reads the first failure of a node text and of a wallet info', () => {
    // cardano-cli on cardano-node 11.0.1, rules-pv11v7.json case multi, verbatim up to the start of the tail list
    expect(
      headFailure(
        'Error: Error while submitting tx: ShelleyTxValidationError ShelleyBasedEraConway (ConwayApplyTxError (ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO Mismatch (RelGTEQ) {supplied: Coin 10, expected: Coin 162157})) :| [',
      ),
    ).toEqual(['ConwayUtxowFailure', 'UtxoFailure', 'FeeTooSmallUTxO']);
    // same node, case badSignature, verbatim
    expect(
      headFailure(
        'Error: Error while submitting tx: ShelleyTxValidationError ShelleyBasedEraConway (ConwayApplyTxError (ConwayUtxowFailure (InvalidWitnessesUTXOW (VKey (VerKeyEd25519DSIGN "e5d83a02058d730af3d9bbf74379782bb34699ac63a1bb7caf43f80055a7710b") :| [])) :| []))',
      ),
    ).toEqual(['ConwayUtxowFailure', 'InvalidWitnessesUTXOW']);
    // the wallet's own format
    expect(headFailure('ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))]')).toEqual([
      'ConwayUtxowFailure',
      'UtxoFailure',
      'UtxosFailure',
      'ValidationTagMismatch',
    ]);
    expect(headFailure('ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]')).toEqual(['ConwayMempoolFailure']);
    expect(() => headFailure('Ogmios 3999: something new')).toThrow(/no ConwayApplyTxError/);
  });
});

describe('rejections on the devnet, against the list the node prints', () => {
  let devnet: Devnet;
  let params: DevnetParams;

  beforeAll(async () => {
    devnet = await startDevnet({ name: NAME });
    params = await devnetParams(devnet.ogmiosUrl);
  });
  afterAll(async () => {
    await devnet?.stop();
  });

  /** Submits through the wallet, expects a refusal, and returns its info next to the node's text for the same bytes. */
  async function refusedByBoth(w: ChainWallet, signed: string): Promise<{ info: string; node: string }> {
    const refusal = (await rejectionOf(w.api.submitTx(signed))) as { code: number; info: string };
    expect(refusal.code).toBe(2);
    const node = cardanoCliSubmit(nodeContainer(NAME), signed);
    expect(node.accepted).toBe(false);
    expect(headFailure(node.text)).toEqual(headFailure(refusal.info));
    return { info: refusal.info, node: node.text };
  }

  it('refuses a transaction with a spent input as BadInputsUTxO, the head of the list the node prints', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 0);
    const [funds] = await w.ledger.getWalletUtxos();
    const pay = settleFee(params, 1, (fee) =>
      buildTx({
        inputs: [funds!.input],
        outputs: [
          { address: accountAddress(9), lovelace: 10_000_000n },
          { address: w.address, lovelace: funds!.lovelace - 10_000_000n - fee },
        ],
        fee,
      }),
    );
    const paid = await signAndSubmit(w, pay.tx);
    await waitSettled(w);

    // With every input spent, node 11 stops at its mempool check. One live input lets the ledger rules run.
    const change = funds!.lovelace - 10_000_000n - pay.fee;
    const double = settleFee(params, 1, (fee) =>
      buildTx({ inputs: [funds!.input, { txId: hexToBytes(paid.id), index: 1n }], outputs: [{ address: w.address, lovelace: change - fee }], fee }),
    );
    // signTx still resolves the spent genesis UTxO, the wallet has seen it.
    const signed = addWalletWitnesses(double.tx, await w.api.signTx(double.tx, false));
    const { info } = await refusedByBoth(w, signed);
    expect(headFailure(info)).toEqual(['ConwayUtxowFailure', 'UtxoFailure', 'BadInputsUTxO']);
    expect(info).toContain(`${bytesToHex(funds!.input.txId)}#0`);
    // The refusal changes nothing for the wallet.
    expect(await w.ledger.pendingTxIds()).toEqual([]);
    expect(await walletOutpoints(w)).toEqual([`${paid.id}#1`]);
  });

  describe('Plutus spends of a locked UTxO', () => {
    let w: ChainWallet;
    let locked: Utxo;
    let walletUtxo: Utxo;

    beforeAll(async () => {
      w = await chainWallet(devnet.ogmiosUrl, 1);
      const [funds] = await w.ledger.getWalletUtxos();
      const lock = settleFee(params, 1, (fee) =>
        buildTx({
          inputs: [funds!.input],
          outputs: [],
          fee,
          extraBodyEntries: new Map([
            [
              1n,
              [
                encodeOutput({ input: funds!.input, address: SCRIPT_ADDRESS, lovelace: 5_000_000n, datum: inlineDatum(UNIT_DATA) }),
                encodeOutput({ input: funds!.input, address: w.address, lovelace: funds!.lovelace - 5_000_000n - fee }),
              ],
            ],
          ]),
        }),
      );
      const { id } = await signAndSubmit(w, lock.tx);
      await waitSettled(w);
      [locked] = await w.provider.unspentOutputs([{ txId: hexToBytes(id), index: 0n }]) as [Utxo];
      [walletUtxo] = (await w.ledger.getWalletUtxos()) as [Utxo];
    });

    it('refuses a script data hash over other cost models as ScriptIntegrityHashMismatch, as the node names it', async () => {
      // No costModels: the mainnet and preprod models, as a builder with a fixed set would hash them.
      const spend = settleFee(params, 1, (fee) => plutusSpend({ spends: [{ utxo: locked, script: always, redeemer: 42n }], wallet: walletUtxo, changeAddress: w.address, fee }), EX_UNITS);
      const signed = addWalletWitnesses(spend.tx, await w.api.signTx(spend.tx, false));
      const { info } = await refusedByBoth(w, signed);
      expect(headFailure(info)).toEqual(['ConwayUtxowFailure', 'ScriptIntegrityHashMismatch']);
      expect(await w.provider.unspentOutputs([locked.input])).toHaveLength(1);
    });

    it('refuses is_valid false on a script that passes as ValidationTagMismatch, as the node names it', async () => {
      const spend = settleFee(
        params,
        1,
        (fee) => plutusSpend({ spends: [{ utxo: locked, script: always, redeemer: 42n }], wallet: walletUtxo, changeAddress: w.address, fee, isValid: false, costModels: params.costModels }),
        EX_UNITS,
      );
      const signed = addWalletWitnesses(spend.tx, await w.api.signTx(spend.tx, false));
      const { info } = await refusedByBoth(w, signed);
      expect(headFailure(info)).toEqual(['ConwayUtxowFailure', 'UtxoFailure', 'UtxosFailure', 'ValidationTagMismatch']);
      expect(await w.provider.unspentOutputs([locked.input])).toHaveLength(1);
    });
  });
});
