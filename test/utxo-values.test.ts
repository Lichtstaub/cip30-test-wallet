import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { TransactionOutput } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { encode } from '../src/core/cbor/encode.js';
import { encodeOutput, encodeUtxo, type Utxo } from '../src/core/ledger.js';
import { parseAssetUnits } from '../src/core/value.js';
import { prepareWallet } from '../src/host/config.js';
import { buildLedger } from '../src/page/install.js';
import { POLICY, syntheticInput } from './helpers/synthetic.js';

const P = POLICY;
const address = hexToBytes('00' + '11'.repeat(56));
const base: Utxo = { input: syntheticInput('v', 0n), address, lovelace: 2_000_000n };
// A PlutusV2 always-succeeds style script ref: [2, h'4e4d01000033222220051200120011']
const scriptRefHex = bytesToHex(encode([2n, hexToBytes('4e4d01000033222220051200120011')]));
const inlineDatumHex = 'd87980'; // Constr 0 []
const datumHash = '22'.repeat(32);

const forms: Array<[string, Utxo, string]> = [
  ['coin only, legacy array', base, '82'],
  ['with assets, array with a value pair', { ...base, assets: parseAssetUnits({ [P + '41']: '5' }) }, '82'],
  ['with a datum hash, alonzo array of three', { ...base, datum: { kind: 'hash', hash: hexToBytes(datumHash) } }, '83'],
  ['with an inline datum, babbage map', { ...base, datum: { kind: 'inline', cbor: hexToBytes(inlineDatumHex) } }, 'a3'],
  ['with a script ref, babbage map', { ...base, scriptRef: hexToBytes(scriptRefHex) }, 'a3'],
  ['with assets, inline datum and script ref', { ...base, assets: parseAssetUnits({ [P]: '1' }), datum: { kind: 'inline', cbor: hexToBytes(inlineDatumHex) }, scriptRef: hexToBytes(scriptRefHex) }, 'a4'],
];

describe('UTxO output forms', () => {
  it('keeps a coin-only UTxO byte-identical to 0.5.0', () => {
    expect(bytesToHex(encodeUtxo(base))).toBe(bytesToHex(encode([[base.input.txId, base.input.index], [address, 2_000_000n]] as never)));
  });

  it.each(forms)('%s: CSL and Evolution parse it, the output starts with the expected header', (_name, utxo, head) => {
    const outputHex = bytesToHex(encode(encodeOutput(utxo)));
    expect(outputHex.startsWith(head)).toBe(true);
    const csl = CSL.TransactionUnspentOutput.from_hex(bytesToHex(encodeUtxo(utxo)));
    expect(csl.output().amount().coin().to_str()).toBe('2000000');
    expect(() => TransactionOutput.fromCBORHex(outputHex)).not.toThrow();
  });

  it('CSL reads back assets, datum hash, inline datum and script ref', () => {
    const [, , , inline, script, all] = forms.map(([, u]) => CSL.TransactionUnspentOutput.from_hex(bytesToHex(encodeUtxo(u))).output());
    expect(all!.amount().multiasset()!.get_asset(CSL.ScriptHash.from_hex(P), CSL.AssetName.new(new Uint8Array())).to_str()).toBe('1');
    expect(inline!.plutus_data()!.to_hex()).toBe(inlineDatumHex);
    expect(script!.script_ref()!.to_hex()).toContain('4e4d01000033222220051200120011');
    const withHash = CSL.TransactionUnspentOutput.from_hex(bytesToHex(encodeUtxo(forms[2]![1]))).output();
    expect(withHash.data_hash()!.to_hex()).toBe(datumHash);
  });
});

describe('walletOptions.utxos with assets, datum and script ref', () => {
  it('flows from prepareWallet through the page config into the ledger', async () => {
    const w = prepareWallet({
      utxos: [
        { lovelace: 3_000_000, assets: { [P.toUpperCase() + '41']: 7 } },
        { lovelace: 2_000_000, datumHash, scriptRef: scriptRefHex },
      ],
    });
    expect(w.config.utxos[0]).toEqual({ lovelace: '3000000', assets: { [P + '41']: '7' } });
    const ledger = buildLedger(w.config, address);
    const [first, second] = await ledger.getWalletUtxos();
    expect(first!.assets!.get(P)!.get('41')).toBe(7n);
    expect(second!.datum).toEqual({ kind: 'hash', hash: hexToBytes(datumHash) });
    expect(bytesToHex(second!.scriptRef!)).toBe(scriptRefHex);
  });

  it('accepts a native script as reference script, CSL reads it back', async () => {
    const native = bytesToHex(encode([0n, [0n, new Uint8Array(28).fill(7)]]));
    const w = prepareWallet({ utxos: [{ lovelace: 2_000_000, scriptRef: native }] });
    const [utxo] = await buildLedger(w.config, address).getWalletUtxos();
    expect(CSL.TransactionUnspentOutput.from_hex(bytesToHex(encodeUtxo(utxo!))).output().script_ref()!.is_native_script()).toBe(true);
  });

  it('refuses malformed entries in Node with the entry named', () => {
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, assets: { zz: 1 } }] })).toThrow(/utxos\[0\]/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, assets: null as never }] })).toThrow(/utxos\[0\]\.assets must be an object/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, datumHash: 'ab' }] })).toThrow(/utxos\[0\]\.datumHash/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, datumHash, inlineDatum: inlineDatumHex }] })).toThrow(/either datumHash or inlineDatum/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, inlineDatum: 'ff' }] })).toThrow(/utxos\[0\]\.inlineDatum/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, scriptRef: bytesToHex(encode([7n, new Uint8Array(1)])) }] })).toThrow(/utxos\[0\]\.scriptRef/);
    // Syntactically valid CBOR of the wrong shape, all three rejected by CSL too.
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, inlineDatum: 'f5' }] })).toThrow(/utxos\[0\]\.inlineDatum/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, scriptRef: '820201' }] })).toThrow(/utxos\[0\]\.scriptRef/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, scriptRef: '820040' }] })).toThrow(/utxos\[0\]\.scriptRef/);
    // Quantities are checked per UTxO and as a sum over all owned UTxOs.
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, assets: { [P]: 2 ** 60 } }] })).toThrow(/safe integer/);
    expect(() => prepareWallet({ utxos: [{ lovelace: 1, assets: { [P]: '18446744073709551615' } }, { lovelace: 1, assets: { [P]: 1 } }] })).toThrow(/sum.*2\^64/);
    expect(() =>
      prepareWallet({ foreignUtxos: [{ txId: '00'.repeat(32), index: 0, addressHex: '00' + '11'.repeat(56), lovelace: 1, assets: { [P]: 0 } }] }),
    ).toThrow(/foreignUtxos\[0\]/);
  });
});
