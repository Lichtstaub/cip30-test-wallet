import { blake2b } from '@noble/hashes/blake2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { encodeOutput, type Utxo } from '../src/core/ledger.js';
import { deriveAccount } from '../src/derive/index.js';
import { languageViews } from '../src/host/checks/script-integrity.js';
import { DEFAULT_MNEMONIC } from '../src/host/config.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { rejectionOf } from '../test/helpers/page.js';
import { plutusScript } from '../test/helpers/plutus-fixtures.js';
import { inlineDatum, plutusSpend, UNIT_DATA, withVKeys } from '../test/helpers/plutus-spend.js';
import { scriptAddress } from '../test/helpers/synthetic.js';
import { addWalletWitnesses, chainWallet, devnetParams, settleFee, signAndSubmit, waitSettled, type ChainWallet, type DevnetParams } from './helpers/chain-wallet.js';
import { nodeContainer, startDevnet, type Devnet } from './helpers/devnet.js';
import { cardanoCliSubmit, headFailure } from './helpers/node-cli.js';

const NAME = 'chw-devnet-names';
const always = plutusScript('v3_always_succeeds');
const SCRIPT_ADDRESS = scriptAddress(always.hash);

let devnet: Devnet;
let params: DevnetParams;
let w: ChainWallet;
let lockSigned: string;
let locked: Utxo;
let walletUtxo: Utxo;

beforeAll(async () => {
  devnet = await startDevnet({ name: NAME });
  params = await devnetParams(devnet.ogmiosUrl);
  w = await chainWallet(devnet.ogmiosUrl, 0);
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
  const { signed, id } = await signAndSubmit(w, lock.tx);
  lockSigned = signed;
  await waitSettled(w);
  [locked] = (await w.provider.unspentOutputs([{ txId: hexToBytes(id), index: 0n }])) as [Utxo];
  [walletUtxo] = (await w.ledger.getWalletUtxos()) as [Utxo];
});
afterAll(async () => {
  await devnet?.stop();
});

describe('names the ledger checks write, as cardano-node 11.0.1 prints them', () => {
  it('prints the is_valid flag of a passing script as (IsValid False) PassedUnexpectedly', async () => {
    const spend = settleFee(
      params,
      1,
      (fee) => plutusSpend({ spends: [{ utxo: locked, script: always, redeemer: 42n }], wallet: walletUtxo, changeAddress: w.address, fee, isValid: false, costModels: params.costModels }),
      { mem: 100_000n, steps: 10_000_000n },
    );
    const signed = addWalletWitnesses(spend.tx, await w.api.signTx(spend.tx, false));
    const node = cardanoCliSubmit(nodeContainer(NAME), signed);
    expect(node.accepted).toBe(false);
    expect(node.text).toContain('ValidationTagMismatch (IsValid False) PassedUnexpectedly');
  });

  it('names the reward purpose ConwayRewarding in ExtraRedeemers', () => {
    const me = deriveAccount(DEFAULT_MNEMONIC, 0);
    // A reward redeemer at index 0 in a transaction without withdrawals: data 0, ExUnits 1 and 1.
    const redeemers = [[3n, 0n, 0n, [1n, 1n]]];
    // No Plutus script is needed or provided, so the language views are the empty map.
    const scriptDataHash = blake2b(concat(encode(redeemers as never), languageViews(new Set<1 | 2 | 3>(), params.costModels)), { dkLen: 32 });
    const opts = (fee: bigint) => ({
      inputs: [walletUtxo.input],
      outputs: [{ address: w.address, lovelace: walletUtxo.lovelace - fee }],
      fee,
      extraBodyEntries: new Map<bigint, unknown>([
        [11n, scriptDataHash],
        [13n, new Tagged(258n, [[walletUtxo.input.txId, walletUtxo.input.index]])],
      ]),
      witnessSet: new Map<bigint, unknown>([[5n, redeemers]]),
    });
    const { fee } = settleFee(params, 1, (f) => buildTx(opts(f)), { mem: 1n, steps: 1n });
    const node = cardanoCliSubmit(nodeContainer(NAME), withVKeys(opts(fee), [me.payment]));
    expect(node.accepted).toBe(false);
    expect(node.text).toMatch(/ExtraRedeemers[\s\S]*ConwayRewarding/);
  });

  it('refuses a resubmitted transaction as ConwayMempoolFailure, in the wallet and in the node alike', async () => {
    const refusal = (await rejectionOf(w.api.submitTx(lockSigned))) as { code: number; info: string };
    expect(refusal.code).toBe(2);
    expect(headFailure(refusal.info)).toEqual(['ConwayMempoolFailure']);
    expect(refusal.info).toContain('All inputs are spent');
    const node = cardanoCliSubmit(nodeContainer(NAME), lockSigned);
    expect(node.accepted).toBe(false);
    expect(headFailure(node.text)).toEqual(['ConwayMempoolFailure']);
  });
});
