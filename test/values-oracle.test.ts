import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Address, Assets, Transaction, TransactionHash, UTxO, Value } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode, Tagged, type CborValue } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { cslTxId, cslVerifiedKeys, cslVerifiedKeysOfTx } from './helpers/csl-governance.js';
import { evolutionBuild } from './helpers/evolution-build.js';
import { enableChw } from './helpers/page.js';
import { POLICY } from './helpers/synthetic.js';

// Two policies, asset names of different length, one asset spread over two
// UTxOs and one with an empty name, so order and summing are both exercised.
const P1 = '01'.repeat(28);
const P9 = POLICY;
const w = prepareWallet({
  utxos: [
    { lovelace: 10_000_000, assets: { [P9 + '41']: 5, [P9 + '626262']: 1, [P1]: 2 } },
    { lovelace: 3_000_000, assets: { [P9 + '41']: 4 } },
    { lovelace: 4_000_000 },
  ],
});
const address = parseAddressArg(w.addresses.payment);

async function walletApi() {
  const target: InstallTarget = {};
  installWallet(w.config, target);
  return enableChw(target);
}

/** The value part of an output in either form, re-encoded on its own for Evolution. */
function outputValueHex(utxoHex: string): string {
  const [, output] = decode(hexToBytes(utxoHex)) as [unknown, CborValue];
  const value = output instanceof Map ? output.get(1n)! : (output as CborValue[])[1]!;
  return bytesToHex(encode(value));
}

describe('values against CSL and Evolution', () => {
  it('Evolution sums the UTxO values to the same balance the wallet reports', async () => {
    const api = await walletApi();
    const balanceHex = await api.getBalance();
    const values = (await api.getUtxos())!.map((hex) => Value.fromCBORHex(outputValueHex(hex)));
    const sum = values.reduce((a, b) => Value.add(a, b));
    const balance = Value.fromCBORHex(balanceHex);
    expect(Value.geq(sum, balance) && Value.geq(balance, sum)).toBe(true);
    expect(Value.getAda(balance)).toBe(17_000_000n);
  });

  it('CSL reads the same balance, including the asset spread over two UTxOs and the empty name', async () => {
    const csl = CSL.Value.from_hex(await (await walletApi()).getBalance());
    const q = (policy: string, name: string) => csl.multiasset()!.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(hexToBytes(name))).to_str();
    expect(csl.coin().to_str()).toBe('17000000');
    expect([q(P9, '41'), q(P9, '626262'), q(P1, '')]).toEqual(['9', '1', '2']);
  });

  it('CSL parses every UTxO the wallet returns', async () => {
    for (const hex of (await (await walletApi()).getUtxos())!) expect(() => CSL.TransactionUnspentOutput.from_hex(hex)).not.toThrow();
  });

  it('an Evolution-built token spend: signed, merged by Evolution with the same id, witness valid in the merged transaction', async () => {
    const first = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const third = syntheticOwnedUtxo(w.config.name, 2, address, 4_000_000n);
    const available = [
      new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(first.input.txId), index: 0n, address: Address.fromBytes(address), assets: Assets.merge(Assets.fromHexStrings(P9, '41', 5n, 10_000_000n), Assets.merge(Assets.fromHexStrings(P9, '626262', 1n), Assets.fromHexStrings(P1, '', 2n))) }),
      new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(third.input.txId), index: 0n, address: Address.fromBytes(address), assets: Assets.fromLovelace(4_000_000n) }),
    ];
    const recipient = Address.fromBytes(hexToBytes('00' + '22'.repeat(56)));
    const tx = await evolutionBuild((b) => b.payToAddress({ address: recipient, assets: Assets.fromHexStrings(P9, '41', 2n, 2_000_000n) }), address, available);
    const ws = await (await walletApi()).signTx(tx, false);
    expect(cslVerifiedKeys(tx, ws)).toEqual([w.paymentPublicKeyHex]);
    const merged = Transaction.addVKeyWitnessesHex(tx, ws);
    expect(cslTxId(merged)).toBe(cslTxId(tx));
    expect(cslVerifiedKeysOfTx(merged)).toEqual([w.paymentPublicKeyHex]);
  });

  it('a transaction with collateral input, return and total: merged by Evolution with the same id, witness valid', async () => {
    const third = syntheticOwnedUtxo(w.config.name, 2, address, 4_000_000n);
    const first = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const tx = buildTx({
      inputs: [first.input],
      outputs: [{ address, lovelace: 9_000_000n }],
      fee: 200_000n,
      extraBodyEntries: new Map<bigint, unknown>([
        [13n, new Tagged(258n, [[third.input.txId, third.input.index]])],
        [16n, [address, 3_700_000n]],
        [17n, 300_000n],
      ]),
    });
    const ws = await (await walletApi()).signTx(tx, false);
    const merged = Transaction.addVKeyWitnessesHex(tx, ws);
    expect(cslTxId(merged)).toBe(cslTxId(tx));
    expect(cslVerifiedKeysOfTx(merged)).toEqual([w.paymentPublicKeyHex]);
  });
});
