import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { APIErrorCode, TxSignErrorCode } from '../src/core/errors.js';
import type { Utxo } from '../src/core/ledger.js';
import { deprecatedCertificate, formsOutOfScope, requirements } from '../src/core/requirements.js';
import { buildTx } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';

const h = (n: number) => new Uint8Array(28).fill(n);
const keyAddress = hexToBytes('00' + '01'.repeat(28) + '02'.repeat(28));
const utxo: Utxo = { input: syntheticInput('req', 0n), address: keyAddress, lovelace: 5_000_000n };
const bodyWith = (entries: Array<[bigint, unknown]>) =>
  parseTransaction(hexToBytes(buildTx({ inputs: [utxo.input], outputs: [], fee: 1n, extraBodyEntries: new Map(entries) }))).body;
const reqsOf = (entries: Array<[bigint, unknown]>) => requirements(bodyWith(entries), [utxo]);
const hexes = (hashes: { keyHash: Uint8Array }[]) => hashes.map((k) => bytesToHex(k.keyHash));
const key = (n: number) => [0n, h(n)];
const script = (n: number) => [1n, h(n)];
const anchor = ['https://example.com/a.json', new Uint8Array(32)];

describe('requirements: the witness table of the spec, row by row', () => {
  it('certificate 0 (registration without deposit) needs no witness', () => {
    expect(reqsOf([[4n, [[0n, key(1)]]]]).keys).toHaveLength(1); // only the input
  });

  // Valid Conway shapes, one per certificate, conway.cddl lines 434 to 539.
  const certOf = (index: bigint, cred: unknown[]): unknown[] =>
    ({
      1: [1n, cred],
      2: [2n, cred, h(7)],
      7: [7n, cred, 2_000_000n],
      8: [8n, cred, 2_000_000n],
      9: [9n, cred, key(2)],
      10: [10n, cred, h(7), key(2)],
      11: [11n, cred, h(7), 2_000_000n],
      12: [12n, cred, key(2), 2_000_000n],
      13: [13n, cred, h(7), key(2), 2_000_000n],
      16: [16n, cred, 500_000_000n, null],
      17: [17n, cred, 500_000_000n],
      18: [18n, cred, anchor],
    })[Number(index)]!;

  it.each([1n, 2n, 7n, 8n, 9n, 10n, 11n, 12n, 13n])('certificate %s needs its stake credential', (index) => {
    const reqs = reqsOf([[4n, [certOf(index, key(1))]]]);
    expect(hexes(reqs.keys)).toContain(bytesToHex(h(1)));
    expect(reqs.keys.find((k) => bytesToHex(k.keyHash) === bytesToHex(h(1)))!.foreignOnly).toBe(false);
  });

  it.each([16n, 17n, 18n])('certificate %s needs its DRep credential', (index) => {
    expect(hexes(reqsOf([[4n, [certOf(index, key(2))]]]).keys)).toContain(bytesToHex(h(2)));
  });

  it('pool registration needs operator and every owner, all foreign only', () => {
    const poolParams = [h(5), new Uint8Array(32), 1n, 340_000_000n, new Tagged(30n, [0n, 1n]), hexToBytes('e0' + '01'.repeat(28)), new Tagged(258n, [h(1), h(6)]), [], null];
    const reqs = reqsOf([[4n, [[3n, ...poolParams]]]]);
    const pool = reqs.keys.filter((k) => k.source.startsWith('certificate 3'));
    expect(hexes(pool)).toEqual([bytesToHex(h(5)), bytesToHex(h(1)), bytesToHex(h(6))]);
    expect(pool.every((k) => k.foreignOnly)).toBe(true);
  });

  it('pool retirement and both committee certificates are foreign only', () => {
    const reqs = reqsOf([[4n, [[4n, h(5), 300n], [14n, key(8), key(9)], [15n, key(8), null]]]]);
    expect(reqs.keys.filter((k) => k.source.startsWith('certificate')).every((k) => k.foreignOnly)).toBe(true);
  });

  it('a certificate with a script credential is a script requirement', () => {
    const reqs = reqsOf([[4n, [[9n, script(1), key(2)]]]]);
    expect(reqs.scripts.map((s) => bytesToHex(s.scriptHash))).toEqual([bytesToHex(h(1))]);
    expect(formsOutOfScope(reqs)[0]).toMatch(/certificate 9 \(delegation_to_drep\) with a script credential/);
  });

  it('an unknown certificate index is unsupported, naming it', () => {
    expect(reqsOf([[4n, [[42n, key(1)]]]]).unsupported).toEqual(['certificate 42']);
  });

  it('certificates 5 and 6 are deprecated, found without reading their fields', () => {
    const body = bodyWith([[4n, [[9n, key(1), key(2)], [6n, 'anything']]]]);
    expect(deprecatedCertificate(body)).toBe('certificate 6 (move_instantaneous_rewards)');
    expect(deprecatedCertificate(bodyWith([[4n, [[5n]]]]))).toBe('certificate 5 (genesis_key_delegation)');
  });

  it('a registration without deposit (0) needs no witness even with a script credential', () => {
    const reqs = reqsOf([[4n, [[0n, script(1)]]]]);
    expect(reqs.scripts).toEqual([]);
    expect(reqs.keys).toHaveLength(1);
  });

  it.each([
    ['a credential with tag 7', [9n, [7n, h(1)], key(2)]],
    ['a certificate without its credential', [7n]],
    ['a registration without its credential', [0n]],
    ['a deposit registration without its deposit', [7n, key(1)]],
    ['a DRep update without its anchor field', [18n, key(2)]],
    ['pool owners that are no set', [3n, h(5), new Uint8Array(32), 1n, 340_000_000n, new Tagged(30n, [0n, 1n]), hexToBytes('e0' + '01'.repeat(28)), 7n, [], null]],
    ['a pool registration with a missing field', [3n, h(5)]],
  ])('%s is InvalidRequest, never a raw Error', (_name, cert) => {
    let caught: unknown;
    try {
      reqsOf([[4n, [cert]]]);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(Error);
    expect(caught).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('voters: DRep key is ours to match, committee and pool are foreign only, scripts are script requirements, others unsupported', () => {
    const id = [new Uint8Array(32), 0n];
    const votes = new Map<unknown, unknown>([
      [[2n, h(2)], new Map([[id, [1n, null]]])],
      [[0n, h(3)], new Map([[id, [1n, null]]])],
      [[4n, h(4)], new Map([[id, [1n, null]]])],
      [[3n, h(5)], new Map([[id, [1n, null]]])],
      [[9n, h(6)], new Map([[id, [1n, null]]])],
    ]);
    const reqs = reqsOf([[19n, votes]]);
    const votesOnly = reqs.keys.filter((k) => k.source.startsWith('vote'));
    expect(votesOnly.map((k) => [bytesToHex(k.keyHash), k.foreignOnly])).toEqual([
      [bytesToHex(h(2)), false],
      [bytesToHex(h(3)), true],
      [bytesToHex(h(4)), true],
    ]);
    expect(reqs.scripts.map((s) => bytesToHex(s.scriptHash))).toEqual([bytesToHex(h(5))]);
    expect(reqs.unsupported).toEqual(['vote by voter type 9']);
  });

  it('proposals need no key witness, a guardrail hash is a script requirement', () => {
    const reward = hexToBytes('e0' + '01'.repeat(28));
    const info = [100n, reward, [6n], anchor];
    const guarded = [100n, reward, [2n, new Map([[reward, 5n]]), h(9)], anchor];
    const reqs = reqsOf([[20n, [info, guarded]]]);
    expect(reqs.keys).toHaveLength(1); // only the input
    expect(reqs.scripts.map((s) => s.source)).toEqual(['proposal 1 (treasury_withdrawals) with a guardrail script']);
  });

  it('treasury value and donation need nothing and are supported body keys', () => {
    const reqs = reqsOf([[21n, 1_000n], [22n, 5n]]);
    expect(reqs.unsupported).toEqual([]);
    expect(reqs.keys).toHaveLength(1);
  });

  it('still reports the body keys M4 does not cover (collateral inputs, 13)', () => {
    expect(reqsOf([[13n, new Tagged(258n, [[utxo.input.txId, 0n]])]]).unsupported).toEqual(['body key 13 (collateral inputs)']);
  });

  it('exports code 3 for deprecated certificates', () => {
    expect(TxSignErrorCode.DeprecatedCertificate).toBe(3);
  });

  it('a guardrail that is not exactly 28 bytes throws InvalidRequest', () => {
    const reward = hexToBytes('e0' + '01'.repeat(28));
    const guarded = [100n, reward, [2n, new Map([[reward, 5n]]), new Uint8Array(27)], ['https://example.com/a.json', new Uint8Array(32)]];
    let caught: unknown;
    try {
      reqsOf([[20n, [guarded]]]);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(Error);
    expect(caught).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});
