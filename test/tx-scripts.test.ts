import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decodeItem, mapValueOffsets, Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { APIErrorCode } from '../src/core/errors.js';
import { parseTxHex } from '../src/core/sign-tx.js';
import { installWallet, type InstallTarget } from '../src/page/install.js';
import { buildTx, spliceWitnessSet } from './helpers/build-tx.js';
import { enableChw, testConfig } from './helpers/page.js';
import { syntheticInput } from './helpers/synthetic.js';

const h = (n: number) => new Uint8Array(28).fill(n);
const COMPILED = hexToBytes('500100003232222533002494984d260011');
const input = syntheticInput('tx-scripts', 0n);
const txWith = (body: Array<[bigint, unknown]> = [], witnessSet?: Map<bigint, unknown>) =>
  buildTx({ inputs: [input], outputs: [], fee: 1n, extraBodyEntries: new Map(body), ...(witnessSet ? { witnessSet } : {}) });
const parse = (hex: string) => parseTransaction(hexToBytes(hex));
const hashes = (hex: string) => parse(hex).scripts.map((s) => bytesToHex(s.hash));
const refusal = (hex: string): unknown => {
  try {
    parseTxHex(hex);
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('mapValueOffsets', () => {
  it('finds the value of every integer key, skipping other keys', () => {
    const bytes = encode(new Map<unknown, unknown>([[1n, 'a'], ['x', 2n], [7n, [3n]]]) as never);
    const offsets = mapValueOffsets(bytes, 0);
    expect([...offsets.keys()]).toEqual([1n, 7n]);
    expect(decodeItem(bytes, offsets.get(7n)!).value).toEqual([3n]);
  });
});

describe('scripts in the witness set', () => {
  it('reads native and Plutus V1 to V3 scripts from a CSL witness set, with CSL hashes, in key order', () => {
    const native = CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_bytes(h(1))));
    const natives = CSL.NativeScripts.new();
    natives.add(native);
    const plutus = [CSL.PlutusScript.new(COMPILED), CSL.PlutusScript.new_v2(COMPILED), CSL.PlutusScript.new_v3(COMPILED)];
    const list = CSL.PlutusScripts.new();
    for (const p of plutus) list.add(p);
    const witnesses = CSL.TransactionWitnessSet.new();
    witnesses.set_native_scripts(natives);
    witnesses.set_plutus_scripts(list);
    const inputs = CSL.TransactionInputs.new();
    inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(input.txId), 0));
    const tx = CSL.Transaction.new(CSL.TransactionBody.new_tx_body(inputs, CSL.TransactionOutputs.new(), CSL.BigNum.from_str('1')), witnesses);
    expect(parse(tx.to_hex()).scripts.map((s) => [s.language, bytesToHex(s.hash)])).toEqual([
      [0, native.hash().to_hex()],
      [1, plutus[0]!.hash().to_hex()],
      [2, plutus[1]!.hash().to_hex()],
      [3, plutus[2]!.hash().to_hex()],
    ]);
  });

  it('reads a script list as a plain array, a tag 258 set or an indefinite array', () => {
    const script = [0n, h(2)];
    const expected = hashes(txWith([], new Map([[1n, [script]]])));
    expect(expected).toHaveLength(1);
    expect(hashes(txWith([], new Map([[1n, new Tagged(258n, [script])]])))).toEqual(expected);
    expect(hashes(spliceWitnessSet(txWith(), 'a1019f' + bytesToHex(encode(script as never)) + 'ff'))).toEqual(expected);
  });

  it('hashes a native script in the witness set over its original bytes', () => {
    const indefinite = '82019f8200581c' + '11'.repeat(28) + '82041864ff';
    expect(hashes(spliceWitnessSet(txWith(), 'a10181' + indefinite))).toEqual(['d2f5e1d493b9ff14135d320af35c375a507e8892c097bf7e0381e54a']);
  });

  it('a transaction without scripts has none', () => {
    expect(parse(txWith()).scripts).toEqual([]);
  });

  it.each([
    ['a malformed native script', new Map<bigint, unknown>([[1n, [[9n]]]])],
    ['a Plutus script that is no byte string', new Map<bigint, unknown>([[7n, [5n]]])],
    ['a script list that is no array', new Map<bigint, unknown>([[6n, 5n]])],
    ['an empty native script list', new Map<bigint, unknown>([[1n, []]])],
    ['an empty Plutus V3 set', new Map<bigint, unknown>([[7n, new Tagged(258n, [])]])],
  ])('%s is InvalidRequest', (_name, witnessSet) => {
    expect(refusal(txWith([], witnessSet))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});

describe('script related body fields', () => {
  const mint = (entries: Array<[Uint8Array, Array<[Uint8Array, bigint]>]>) => new Map(entries.map(([policy, assets]) => [policy, new Map(assets)]));

  it('reads mint policies in map order', () => {
    const body = parse(txWith([[9n, mint([[h(2), [[new Uint8Array(0), 1n]]], [h(1), [[hexToBytes('41'), -3n]]]])]])).body;
    expect(body.mintPolicies.map(bytesToHex)).toEqual([h(2), h(1)].map(bytesToHex));
  });

  it.each([
    ['an empty mint', new Map()],
    ['a 27 byte policy id', mint([[new Uint8Array(27), [[new Uint8Array(0), 1n]]]])],
    ['a policy without assets', new Map([[h(1), new Map()]])],
    ['a zero quantity', mint([[h(1), [[new Uint8Array(0), 0n]]]])],
    ['a quantity above int64', mint([[h(1), [[new Uint8Array(0), 2n ** 63n]]]])],
    ['a 33 byte asset name', mint([[h(1), [[new Uint8Array(33), 1n]]]])],
  ])('%s is InvalidRequest', (_name, value) => {
    expect(refusal(txWith([[9n, value]]))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('reads reference inputs, an empty set is InvalidRequest', () => {
    const ref = syntheticInput('tx-scripts-ref', 3n);
    const body = parse(txWith([[18n, new Tagged(258n, [[ref.txId, ref.index]])]])).body;
    expect(body.referenceInputs.map((i) => [bytesToHex(i.txId), i.index])).toEqual([[bytesToHex(ref.txId), 3n]]);
    expect(refusal(txWith([[18n, []]]))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it.each([3n, 8n, 9n, 13n, 18n])('body key %s holding CBOR undefined is InvalidRequest, not a missing field', (key) => {
    expect(refusal(txWith([[key, undefined]]))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('an undefined body field is refused before the signRejected prompt quirk', async () => {
    const target: InstallTarget = {};
    installWallet(testConfig({ quirks: { signRejected: true } }), target);
    const api = await enableChw(target);
    await expect(api.signTx(txWith([[9n, undefined]]), false)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('reads ttl (3) and validity start (8), a negative value is InvalidRequest', () => {
    const body = parse(txWith([[3n, 200n], [8n, 100n]])).body;
    expect([body.ttl, body.validityStart]).toEqual([200n, 100n]);
    const plain = parse(txWith()).body;
    expect([plain.ttl, plain.validityStart, plain.mintPolicies, plain.referenceInputs]).toEqual([undefined, undefined, [], []]);
    expect(refusal(txWith([[3n, -1n]]))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    expect(refusal(txWith([[8n, 'soon']]))).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});
