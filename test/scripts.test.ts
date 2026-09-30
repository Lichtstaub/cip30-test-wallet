import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { arrayItemRanges, decode, Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { evaluateNativeScript, nativeKeyHashes, parseNativeScript, providedScript, scriptFromRef, scriptHash, type NativeScript } from '../src/core/scripts.js';
import { isNativeScript } from '../src/host/cbor-shapes.js';

const h = (n: number) => new Uint8Array(28).fill(n);
const cslPub = (n: number) => CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_bytes(h(n))));
const cslList = (...items: CSL.NativeScript[]) => {
  const list = CSL.NativeScripts.new();
  for (const item of items) list.add(item);
  return list;
};
// A compiled Plutus script as plutus.json carries it: a CBOR byte string around flat bytes. Never executed.
const COMPILED = hexToBytes('500100003232222533002494984d260011');
const cslPlutus = [(b: Uint8Array) => CSL.PlutusScript.new(b), (b: Uint8Array) => CSL.PlutusScript.new_v2(b), (b: Uint8Array) => CSL.PlutusScript.new_v3(b)];

describe('script hashes against CSL', () => {
  it('hashes native scripts of every type like CSL', () => {
    const scripts = [
      cslPub(1),
      CSL.NativeScript.new_script_all(CSL.ScriptAll.new(cslList(cslPub(1), cslPub(2)))),
      CSL.NativeScript.new_script_any(CSL.ScriptAny.new(cslList(cslPub(1)))),
      CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(2, cslList(cslPub(1), cslPub(2), cslPub(3)))),
      CSL.NativeScript.new_timelock_start(CSL.TimelockStart.new_timelockstart(CSL.BigNum.from_str('100'))),
      CSL.NativeScript.new_timelock_expiry(CSL.TimelockExpiry.new_timelockexpiry(CSL.BigNum.from_str('200'))),
    ];
    for (const script of scripts) {
      expect(bytesToHex(scriptHash(0, script.to_bytes()))).toBe(script.hash().to_hex());
      expect(bytesToHex(providedScript(0, script.to_bytes()).hash)).toBe(script.hash().to_hex());
    }
  });

  it('hashes Plutus V1 to V3 like CSL, over the content of the byte string the witness set carries', () => {
    for (const [i, make] of cslPlutus.entries()) {
      const language = (i + 1) as 1 | 2 | 3;
      expect(bytesToHex(scriptHash(language, COMPILED))).toBe(make(COMPILED).hash().to_hex());
      expect(bytesToHex(providedScript(language, encode(COMPILED)).hash)).toBe(make(COMPILED).hash().to_hex());
    }
  });

  it('reads script references CSL writes, for every language', () => {
    const native = CSL.NativeScript.new_script_all(CSL.ScriptAll.new(cslList(cslPub(1))));
    const refs: Array<[CSL.ScriptRef, string]> = [
      [CSL.ScriptRef.new_native_script(native), native.hash().to_hex()],
      ...cslPlutus.map((make): [CSL.ScriptRef, string] => [CSL.ScriptRef.new_plutus_script(make(COMPILED)), make(COMPILED).hash().to_hex()]),
    ];
    for (const [ref, expected] of refs) {
      // script_ref = #6.24(bytes .cbor script), the wallet keeps the inner bytes
      const tagged = decode(ref.to_bytes());
      expect(tagged).toBeInstanceOf(Tagged);
      expect((tagged as Tagged).tag).toBe(24n);
      expect(bytesToHex(scriptFromRef((tagged as Tagged).value as Uint8Array).hash)).toBe(expected);
    }
  });

  it('hashes a native script over the bytes it arrived in, never re-encoded', () => {
    // all[pubkey 11..11, invalid_before 100], once canonical and once with an indefinite list.
    // CSL re-encodes on parse and reports the canonical hash for both, the ledger keeps the
    // original bytes (MemoBytes, cardano-ledger Allegra/Scripts.hs).
    const canonical = hexToBytes('8201828200581c' + '11'.repeat(28) + '82041864');
    const indefinite = hexToBytes('82019f8200581c' + '11'.repeat(28) + '82041864ff');
    expect(bytesToHex(providedScript(0, canonical).hash)).toBe(CSL.NativeScript.from_bytes(canonical).hash().to_hex());
    expect(bytesToHex(providedScript(0, canonical).hash)).toBe('1c1544173cdd22d5c9e45198eb8f7e07aac7266d8b084990d6dc6a9d');
    // No oracle for the indefinite form: the literal is blake2b-224 over 0x00 and exactly these bytes.
    // A red test here means the bytes were re-encoded, never update the literal to make it pass.
    expect(bytesToHex(scriptHash(0, indefinite))).toBe('d2f5e1d493b9ff14135d320af35c375a507e8892c097bf7e0381e54a');
    expect(bytesToHex(providedScript(0, indefinite).hash)).toBe('d2f5e1d493b9ff14135d320af35c375a507e8892c097bf7e0381e54a');
  });

  it.each([
    ['an unknown language', encode([7n, new Uint8Array(1)])],
    ['a malformed native script', encode([0n, [9n]])],
    ['an empty Plutus script', encode([2n, new Uint8Array(0)])],
    ['a third item', encode([1n, new Uint8Array(1), 0n])],
    ['trailing bytes', concat(encode([1n, new Uint8Array(1)]), Uint8Array.of(0))],
    ['no array', encode(5n)],
  ])('scriptFromRef refuses %s', (_name, ref) => {
    expect(() => scriptFromRef(ref)).toThrow();
  });
});

describe('parseNativeScript', () => {
  it('reads every native script type', () => {
    const value = [1n, [[0n, h(1)], [2n, [[4n, 10n]]], [3n, 1n, [[5n, 20n]]]]];
    expect(parseNativeScript(value)).toEqual({
      type: 'all',
      scripts: [
        { type: 'pubkey', keyHash: h(1) },
        { type: 'any', scripts: [{ type: 'invalidBefore', slot: 10n }] },
        { type: 'nOfK', n: 1n, scripts: [{ type: 'invalidHereafter', slot: 20n }] },
      ],
    });
  });

  it.each([
    ['a 27 byte key hash', [0n, new Uint8Array(27)]],
    ['an unknown type', [6n, 1n]],
    ['a list that is no array', [1n, 5n]],
    ['n above int64', [3n, 2n ** 63n, []]],
    ['a negative slot', [4n, -1n]],
    ['a missing field', [5n]],
    ['an extra field', [0n, h(1), 0n]],
    ['no array at all', 7n],
  ])('refuses %s', (_name, value) => {
    expect(() => parseNativeScript(value as never)).toThrow(/native script/);
  });

  it('refuses nesting deeper than 256 levels instead of overflowing the stack', () => {
    let value: unknown = [0n, h(1)];
    for (let i = 0; i < 300; i++) value = [1n, [value]];
    expect(() => parseNativeScript(value as never)).toThrow(/too deep/);
  });

  it('is the one parser the configuration check uses', () => {
    expect(isNativeScript([3n, 2n ** 63n, []])).toBe(false);
    expect(isNativeScript([3n, -1n, []])).toBe(true);
    expect(isNativeScript([0n, h(1)])).toBe(true);
  });
});

describe('evaluateNativeScript follows evalTimelock', () => {
  const pk = (n: number): NativeScript => ({ type: 'pubkey', keyHash: h(n) });
  const ev = (script: NativeScript, keys: number[], start?: bigint, ttl?: bigint) => evaluateNativeScript(script, keys.map(h), start, ttl);

  it('a pubkey needs its hash among the witnesses', () => {
    expect(ev(pk(1), [1])).toBe(true);
    expect(ev(pk(1), [2])).toBe(false);
  });

  it('all of nothing holds, any of nothing does not', () => {
    expect(ev({ type: 'all', scripts: [] }, [])).toBe(true);
    expect(ev({ type: 'any', scripts: [] }, [])).toBe(false);
  });

  it('n_of_k counts satisfied scripts, n <= 0 always holds, n above k never', () => {
    const three = [pk(1), pk(2), pk(3)];
    expect(ev({ type: 'nOfK', n: 2n, scripts: three }, [1, 3])).toBe(true);
    expect(ev({ type: 'nOfK', n: 2n, scripts: three }, [2])).toBe(false);
    expect(ev({ type: 'nOfK', n: 0n, scripts: three }, [])).toBe(true);
    expect(ev({ type: 'nOfK', n: -2n, scripts: [] }, [])).toBe(true);
    expect(ev({ type: 'nOfK', n: 4n, scripts: three }, [1, 2, 3])).toBe(false);
  });

  it('invalid_before n holds from a validity start of exactly n, not before and not without a start', () => {
    const script: NativeScript = { type: 'invalidBefore', slot: 100n };
    expect(ev(script, [], 100n)).toBe(true);
    expect(ev(script, [], 99n)).toBe(false);
    expect(ev(script, [], undefined, 500n)).toBe(false);
  });

  it('invalid_hereafter n holds up to a ttl of exactly n, not after and not without a ttl', () => {
    const script: NativeScript = { type: 'invalidHereafter', slot: 200n };
    expect(ev(script, [], undefined, 200n)).toBe(true);
    expect(ev(script, [], undefined, 201n)).toBe(false);
    expect(ev(script, [], 0n)).toBe(false);
  });

  it('lists every key hash a script names, at any depth, in script order', () => {
    const script: NativeScript = { type: 'any', scripts: [pk(2), { type: 'all', scripts: [pk(1), { type: 'invalidBefore', slot: 1n }] }] };
    expect(nativeKeyHashes(script).map(bytesToHex)).toEqual([h(2), h(1)].map(bytesToHex));
  });
});

describe('arrayItemRanges', () => {
  it('finds item ranges in definite, indefinite and tag 258 arrays', () => {
    const items = [encode(1n), encode(new Uint8Array(2))];
    const forms = [concat(Uint8Array.of(0x82), ...items), concat(Uint8Array.of(0x9f), ...items, Uint8Array.of(0xff)), concat(hexToBytes('d9010282'), ...items)];
    for (const bytes of forms) {
      const { ranges, next } = arrayItemRanges(bytes, 0, true);
      expect(ranges.map(([start, end]) => bytesToHex(bytes.slice(start, end)))).toEqual(items.map(bytesToHex));
      expect(next).toBe(bytes.length);
    }
  });

  it('refuses a tag 258 where no set is allowed, and anything that is no array', () => {
    expect(() => arrayItemRanges(hexToBytes('d90102820102'), 0, false)).toThrow(/array/);
    expect(() => arrayItemRanges(encode(5n), 0, true)).toThrow(/array/);
  });
});
