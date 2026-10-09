import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { keyHash } from '../src/core/hash.js';
import { encodeOutput } from '../src/core/ledger.js';
import { scriptFromRef } from '../src/core/scripts.js';
import { ogmiosCall, utxoFromOgmios } from '../src/host/chain/ogmios.js';
import { buildTx } from '../test/helpers/build-tx.js';
import { plutusScript } from '../test/helpers/plutus-fixtures.js';
import { inlineDatum, plutusSpend, UNIT_DATA } from '../test/helpers/plutus-spend.js';
import { scriptAddress } from '../test/helpers/synthetic.js';
import { chainWallet, devnetParams, outpoint, settleFee, signAndSubmit, waitSettled, walletOutpoints, type DevnetParams } from './helpers/chain-wallet.js';
import { accountAddress, startDevnet, type Devnet } from './helpers/devnet.js';

const always = plutusScript('v3_always_succeeds');
const SCRIPT_ADDRESS = scriptAddress(always.hash);
// The ExUnits plutusSpend declares by default. The devnet evaluates always_succeeds at 9751 memory and 2836913 steps.
const EX_UNITS = { mem: 100_000n, steps: 10_000_000n };

let devnet: Devnet;
let params: DevnetParams;

beforeAll(async () => {
  devnet = await startDevnet({ name: 'chw-devnet-plutus' });
  params = await devnetParams(devnet.ogmiosUrl);
});
afterAll(async () => {
  await devnet?.stop();
});

describe('scripts on the devnet', () => {
  it('locks 5 ADA at always_succeeds and spends it with a redeemer, both confirmed', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 0);
    const [funds] = await w.ledger.getWalletUtxos();
    const lock = settleFee(params, 1, (fee) =>
      buildTx({
        inputs: [funds!.input],
        outputs: [],
        fee,
        // Outputs with an inline datum need the map form, buildTx writes plain [address, coin] outputs.
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
    const locked = await signAndSubmit(w, lock.tx);
    await waitSettled(w);

    const lockedAt = { txId: hexToBytes(locked.id), index: 0n };
    const [scriptUtxo] = await w.provider.unspentOutputs([lockedAt]);
    expect(scriptUtxo).toMatchObject({ address: SCRIPT_ADDRESS, lovelace: 5_000_000n, datum: inlineDatum(UNIT_DATA) });
    const [walletUtxo] = await w.ledger.getWalletUtxos();
    expect(outpoint(walletUtxo!.input)).toBe(`${locked.id}#1`);

    const spend = settleFee(
      params,
      1,
      (fee) => plutusSpend({ spends: [{ utxo: scriptUtxo!, script: always, redeemer: 42n }], wallet: walletUtxo!, changeAddress: w.address, fee, costModels: params.costModels }),
      EX_UNITS,
    );
    const spent = await signAndSubmit(w, spend.tx);
    await waitSettled(w);

    expect(await w.provider.unspentOutputs([lockedAt])).toEqual([]);
    expect(await walletOutpoints(w)).toEqual([`${spent.id}#0`]);
    const [after] = await w.ledger.getWalletUtxos();
    expect(after!.lovelace).toBe(walletUtxo!.lovelace + 5_000_000n - spend.fee);
  });
  it('reads a native reference script back with the hash the node computed, from the cbor Ogmios sends and from its clauses', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 1);
    const [funds] = await w.ledger.getWalletUtxos();
    const paymentKeyHash = keyHash(hexToBytes(w.prepared.paymentPublicKeyHex));
    // all [signature of the payment key, after slot 42], with definite lengths
    const native = encode([1n, [[0n, paymentKeyHash], [4n, 42n]]]);
    const scriptRef = concat(Uint8Array.of(0x82, 0x00), native);
    const make = settleFee(params, 1, (fee) =>
      buildTx({
        inputs: [funds!.input],
        outputs: [],
        fee,
        extraBodyEntries: new Map([
          [
            1n,
            [
              encodeOutput({ input: funds!.input, address: accountAddress(9), lovelace: 5_000_000n, scriptRef }),
              encodeOutput({ input: funds!.input, address: w.address, lovelace: funds!.lovelace - 5_000_000n - fee }),
            ],
          ],
        ]),
      }),
    );
    const { id } = await signAndSubmit(w, make.tx);
    await waitSettled(w);

    // Ogmios 7.0.0 sends the cbor of a native script also without --include-script-cbor, next to the clauses.
    const answer = (await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/utxo', { outputReferences: [{ transaction: { id }, index: 0 }] })) as {
      result: Array<{ script: Record<string, unknown> }>;
    };
    const script = answer.result[0]!.script;
    expect(script).toMatchObject({
      language: 'native',
      json: { clause: 'all', from: [{ clause: 'signature', from: bytesToHex(paymentKeyHash) }, { clause: 'after', slot: 42 }] },
    });
    expect(script.cbor).toBe(bytesToHex(native));
    // A server that leaves the cbor out: the clauses alone give back the bytes the transaction wrote.
    const clauses = Object.fromEntries(Object.entries(script).filter(([key]) => key !== 'cbor'));
    expect(bytesToHex(utxoFromOgmios({ ...answer.result[0], script: clauses }).scriptRef!)).toBe(bytesToHex(scriptRef));

    const [read] = await w.provider.unspentOutputs([{ txId: hexToBytes(id), index: 0n }]);
    expect(bytesToHex(read!.scriptRef!)).toBe(bytesToHex(scriptRef));
    expect(bytesToHex(scriptFromRef(read!.scriptRef!).hash)).toBe(CSL.NativeScript.from_bytes(native).hash().to_hex());
  });

  it('reads a Plutus V3 reference script back with the bytes written and the hash of the fixture', async () => {
    const w = await chainWallet(devnet.ogmiosUrl, 2);
    const [funds] = await w.ledger.getWalletUtxos();
    // script = [3, plutus_v3_script], the byte string a witness set carries for always_succeeds
    const scriptRef = encode([3n, always.bytes]);
    const make = settleFee(params, 1, (fee) =>
      buildTx({
        inputs: [funds!.input],
        outputs: [],
        fee,
        extraBodyEntries: new Map([
          [
            1n,
            [
              encodeOutput({ input: funds!.input, address: accountAddress(9), lovelace: 5_000_000n, scriptRef }),
              encodeOutput({ input: funds!.input, address: w.address, lovelace: funds!.lovelace - 5_000_000n - fee }),
            ],
          ],
        ]),
      }),
    );
    const { id } = await signAndSubmit(w, make.tx);
    await waitSettled(w);

    // Ogmios sends a Plutus script as the byte string the node hashed.
    const answer = (await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/utxo', { outputReferences: [{ transaction: { id }, index: 0 }] })) as {
      result: Array<{ script: Record<string, unknown> }>;
    };
    expect(answer.result[0]!.script).toEqual({ language: 'plutus:v3', cbor: always.cborHex });

    const [read] = await w.provider.unspentOutputs([{ txId: hexToBytes(id), index: 0n }]);
    expect(bytesToHex(read!.scriptRef!)).toBe(bytesToHex(scriptRef));
    expect(bytesToHex(scriptFromRef(read!.scriptRef!).hash)).toBe(always.hashHex);
  });
});
