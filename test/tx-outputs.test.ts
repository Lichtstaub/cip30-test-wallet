import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode, Tagged } from '../src/core/cbor/decode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { APIErrorCode } from '../src/core/errors.js';
import { parseTxHex } from '../src/core/sign-tx.js';
import { valueFromCbor } from '../src/core/value.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { enableChw, testConfig } from './helpers/page.js';
import { hash28 as h, PLUTUS_V3, syntheticInput } from './helpers/synthetic.js';

const ADDRESS = '00' + '11'.repeat(28) + '22'.repeat(28);
const input = syntheticInput('tx-outputs', 0n);
const refusal = (hex: string): unknown => {
  try {
    parseTxHex(hex);
  } catch (e) {
    return e;
  }
  return undefined;
};
const withOutputs = (outputs: unknown, extra: Array<[bigint, unknown]> = []) =>
  buildTx({ inputs: [input], outputs: [], fee: 1n, extraBodyEntries: new Map<bigint, unknown>([[1n, outputs], ...extra]) });

describe('valueFromCbor', () => {
  it('reads coin and multiasset values, drops zero quantities, names the source in errors', () => {
    expect(valueFromCbor(5n, 'x')).toEqual({ coin: 5n, assets: new Map() });
    const multi = [7n, new Map([[h(9), new Map([[hexToBytes('41'), 2n], [hexToBytes('42'), 0n]])]])];
    expect(valueFromCbor(multi as never, 'x')).toEqual({ coin: 7n, assets: new Map([[bytesToHex(h(9)), new Map([['41', 2n]])]]) });
    expect(() => valueFromCbor(-1n, 'output value')).toThrow('output value must be a cbor value');
    expect(() => valueFromCbor([1n, new Map([[new Uint8Array(27), new Map()]])] as never, 'output value')).toThrow('output value policy ids must be 28 bytes');
    expect(() => valueFromCbor(multi as never, 'output value', true)).toThrow('output value asset quantities must be positive');
  });
});

describe('outputs in the parser', () => {
  it('reads the three output forms CSL writes, and the collateral return', () => {
    const address = CSL.Address.from_bytes(hexToBytes(ADDRESS));
    const plain = CSL.TransactionOutput.new(address, CSL.Value.new(CSL.BigNum.from_str('2000000')));
    const names = CSL.Assets.new();
    names.insert(CSL.AssetName.new(hexToBytes('41')), CSL.BigNum.from_str('5'));
    const multiasset = CSL.MultiAsset.new();
    multiasset.insert(CSL.ScriptHash.from_bytes(h(9)), names);
    const withAssets = CSL.TransactionOutput.new(address, CSL.Value.new_with_assets(CSL.BigNum.from_str('3000000'), multiasset));
    withAssets.set_data_hash(CSL.DataHash.from_bytes(new Uint8Array(32).fill(7)));
    const withInline = CSL.TransactionOutput.new(address, CSL.Value.new(CSL.BigNum.from_str('4000000')));
    withInline.set_plutus_data(CSL.PlutusData.new_integer(CSL.BigInt.from_str('42')));
    const scriptRef = CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_v3(hexToBytes(PLUTUS_V3)));
    withInline.set_script_ref(scriptRef);
    const outputs = CSL.TransactionOutputs.new();
    for (const o of [plain, withAssets, withInline]) outputs.add(o);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const body = CSL.TransactionBody.new_tx_body(inputs, outputs, CSL.BigNum.from_str('1'));
    body.set_collateral_return(plain);
    const parsed = parseTransaction(CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_bytes());

    expect(parsed.isValid).toBe(true);
    const [first, second, third] = parsed.body.outputs;
    expect(bytesToHex(first!.address)).toBe(ADDRESS);
    expect(first).toEqual({ address: hexToBytes(ADDRESS), lovelace: 2_000_000n });
    expect(second!.lovelace).toBe(3_000_000n);
    expect(second!.assets).toEqual(new Map([[bytesToHex(h(9)), new Map([['41', 5n]])]]));
    expect(second!.datum).toEqual({ kind: 'hash', hash: new Uint8Array(32).fill(7) });
    expect(third!.datum).toEqual({ kind: 'inline', cbor: CSL.PlutusData.new_integer(CSL.BigInt.from_str('42')).to_bytes() });
    // script_ref = #6.24(bytes .cbor script), the ledger keeps the inner bytes
    expect(bytesToHex(third!.scriptRef!)).toBe(bytesToHex((decode(scriptRef.to_bytes()) as Tagged).value as Uint8Array));
    expect(parsed.body.collateralReturn).toEqual(first);
  });

  it('reads is_valid false', () => {
    const tx = buildTx({ inputs: [input], outputs: [], fee: 1n, isValid: false });
    expect(parseTransaction(hexToBytes(tx)).isValid).toBe(false);
  });

  it('a transaction without collateral return has none', () => {
    expect(parseTransaction(hexToBytes(withOutputs([]))).body.collateralReturn).toBeUndefined();
  });

  it.each([
    ['outputs that are no array', withOutputs(5n)],
    ['an output that is neither array nor map', withOutputs([5n])],
    ['an output without its value', withOutputs([[hexToBytes(ADDRESS)]])],
    ['an output with a negative coin', withOutputs([[hexToBytes(ADDRESS), -1n]])],
    ['an output with an empty address', withOutputs([[new Uint8Array(0), 1n]])],
    ['a datum hash of 31 bytes', withOutputs([[hexToBytes(ADDRESS), 1n, new Uint8Array(31)]])],
    ['an unknown datum option', withOutputs([new Map<unknown, unknown>([[0n, hexToBytes(ADDRESS)], [1n, 1n], [2n, [2n, 1n]]])])],
    ['a script ref without tag 24', withOutputs([new Map<unknown, unknown>([[0n, hexToBytes(ADDRESS)], [1n, 1n], [3n, new Uint8Array(3)]])])],
    ['a malformed collateral return', withOutputs([], [[16n, 5n]])],
    ['an inline datum that is no plutus_data', withOutputs([new Map<unknown, unknown>([[0n, hexToBytes(ADDRESS)], [1n, 1n], [2n, [1n, new Tagged(24n, Uint8Array.of(0xf5))]]])])],
    ['an inline datum that is no cbor at all', withOutputs([new Map<unknown, unknown>([[0n, hexToBytes(ADDRESS)], [1n, 1n], [2n, [1n, new Tagged(24n, new Uint8Array(0))]]])])],
    ['a script ref that is no script', withOutputs([new Map<unknown, unknown>([[0n, hexToBytes(ADDRESS)], [1n, 1n], [3n, new Tagged(24n, Uint8Array.of(0x00))]])])],
    ['an asset quantity of 0 in an output', withOutputs([[hexToBytes(ADDRESS), [1n, new Map([[h(9), new Map([[new Uint8Array(0), 0n]])]])]]])],
  ])('%s is InvalidRequest', (_name, tx) => {
    expect(refusal(tx)).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('a malformed output is refused before the signHangs prompt quirk', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { signHangs: true } }), target);
    const api = await enableChw(target);
    await expect(api.signTx(withOutputs([5n]), false)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});
