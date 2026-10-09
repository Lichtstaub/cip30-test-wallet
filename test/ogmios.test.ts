import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from 'vitest';
import { isByronAddress } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { ChwError } from '../src/core/errors.js';
import { scriptFromRef } from '../src/core/scripts.js';
import { parseJsonBig } from '../src/host/chain/json.js';
import { chainUnavailable, ogmiosCall, ogmiosProvider, utxoFromOgmios } from '../src/host/chain/ogmios.js';
import { utxoToConfig } from '../src/page/utxo-config.js';
import { rejectionOf } from './helpers/page.js';
import { plutusScript } from './helpers/plutus-fixtures.js';

// Recorded answers in test/fixtures/ogmios, see the README there. The fetch is
// a fake that hands out one prepared Response per call, nothing goes to a network.

const URL_ = 'http://127.0.0.1:1337';
const fixture = (name: string) => readFileSync(`test/fixtures/ogmios/${name}`, 'utf8');
const answer = (name: string, status = 200) => new Response(fixture(name), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

interface Call {
  url: string;
  init: RequestInit;
  body: { jsonrpc: string; method: string; params?: unknown; id: unknown };
}

function fakeFetch(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const next = answers.shift();
    if (next === undefined) throw new Error('the test prepared no further answer');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<ChwError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(ChwError);
  expect((error as ChwError).code).toBe('CHW_CHAIN_UNAVAILABLE');
  return error as ChwError;
}

// The base address of the recorded devnet account A: payment key hash 77da02be..., stake key hash 5199cb32....
const ADDRESS_A_BECH32 = 'addr_test1qpma5q47qqjyj3555fkavdj3x98xp6u3tslngvwk8c8kxqz3n89nypu7zcpuh68wcd5jptznzn3tpadjch0ymqaw9czshjqqnf';
const ADDRESS_A_HEX = '0077da02be0024494694a26dd63651314e60eb915c3f3431d63e0f63005199cb32079e1603cbe8eec36920ac5314e2b0f5b2c5de4d83ae2e05';
const STAKE_A = '5199cb32079e1603cbe8eec36920ac5314e2b0f5b2c5de4d83ae2e05';
const PAYMENT_A = '77da02be0024494694a26dd63651314e60eb915c3f3431d63e0f6300';

describe('ogmiosCall', () => {
  it('posts a JSON-RPC 2.0 request with the given headers and returns the result of an HTTP 200', async () => {
    const { fetch, calls } = fakeFetch(answer('v7-genesis-shelley.json'));
    const out = await ogmiosCall({ url: URL_, headers: { authorization: 'Bearer t' }, fetch }, 'queryNetwork/genesisConfiguration', { era: 'shelley' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer t' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.body).toEqual({ jsonrpc: '2.0', method: 'queryNetwork/genesisConfiguration', params: { era: 'shelley' }, id: null });
    expect(out).toMatchObject({ result: { era: 'shelley', network: 'testnet', networkMagic: 42 } });
  });

  it('leaves params out for a method without them', async () => {
    const { fetch, calls } = fakeFetch(json({ jsonrpc: '2.0', method: 'queryNetwork/tip', result: { slot: 1, id: 'ab' }, id: null }));
    expect(await ogmiosCall({ url: URL_, fetch }, 'queryNetwork/tip')).toEqual({ result: { slot: 1, id: 'ab' } });
    expect(calls[0]!.body).toEqual({ jsonrpc: '2.0', method: 'queryNetwork/tip', id: null });
  });

  it('takes an HTTP 400 with a JSON-RPC error as an answer, code, message and data as Ogmios sent them', async () => {
    const { fetch } = fakeFetch(answer('v7-submit-fee-too-small.json', 400));
    const out = await ogmiosCall({ url: URL_, fetch }, 'submitTransaction', { transaction: { cbor: '00' } });
    expect(out).toEqual({
      error: {
        code: 3122,
        message: expect.stringMatching(/^Insufficient fee!/),
        data: { minimumRequiredFee: { ada: { lovelace: 165149 } }, providedFee: { ada: { lovelace: 1000 } } },
      },
    });
  });

  it('takes a JSON-RPC error on HTTP 200 as an answer too, an error without data has no data key', async () => {
    const { fetch } = fakeFetch(json({ jsonrpc: '2.0', method: 'submitTransaction', error: { code: 3005, message: 'era mismatch' }, id: null }));
    expect(await ogmiosCall({ url: URL_, fetch }, 'submitTransaction', {})).toEqual({ error: { code: 3005, message: 'era mismatch' } });
  });

  it('keeps integers above 2^53 in a result exact', async () => {
    const { fetch } = fakeFetch(answer('v7-utxo-full.json'));
    const out = (await ogmiosCall({ url: URL_, fetch }, 'queryLedgerState/utxo', { addresses: [ADDRESS_A_BECH32] })) as { result: Array<{ value: Record<string, Record<string, unknown>> }> };
    expect(out.result[0]!.value['ada']).toEqual({ lovelace: '45000000000000000' });
    expect(out.result[0]!.value['5d0f747d4eb70739ff667eed99b934de3a3e5054fae1e368902078e3']).toEqual({ '': '18446744073709551615', '746f6b656e': '9007199254740993' });
  });

  it.each([
    ['a gateway error page', new Response('<html>Bad Gateway</html>', { status: 502 }), 'HTTP 502'],
    ['Ogmios without a JSON reply from the node', new Response('', { status: 500 }), 'HTTP 500'],
    ['a JSON body with HTTP 503', json({ jsonrpc: '2.0', error: { code: -32000, message: 'busy' } }, 503), 'HTTP 503'],
    ['a wrong path', new Response('Not Found', { status: 404 }), 'HTTP 404'],
    ['a body that is not JSON', new Response('ok', { status: 200 }), 'HTTP 200 with a body that is not JSON'],
    ['a 400 that is not JSON', new Response('Bad Request', { status: 400 }), 'HTTP 400 with a body that is not JSON'],
    ['JSON without result or error', json({ jsonrpc: '2.0', id: null }), 'HTTP 200 without result or error'],
    ['a 400 without error', json({ jsonrpc: '2.0', result: 1, id: null }, 400), 'HTTP 400 without result or error'],
    ['an error object without a numeric code', json({ jsonrpc: '2.0', error: { code: 'x', message: 'y' }, id: null }, 400), 'HTTP 400 without result or error'],
  ])('throws CHW_CHAIN_UNAVAILABLE for %s', async (_name, response, reason) => {
    const { fetch } = fakeFetch(response);
    const e = await rejection(ogmiosCall({ url: URL_, fetch }, 'queryLedgerState/utxo', {}));
    expect(e.message).toBe(`CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: ${reason}`);
  });

  it('throws CHW_CHAIN_UNAVAILABLE with the reason when fetch rejects', async () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1337'), { code: 'ECONNREFUSED' }) });
    const { fetch } = fakeFetch(refused);
    const e = await rejection(ogmiosCall({ url: URL_, fetch }, 'queryNetwork/tip'));
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryNetwork/tip failed: request failed: ECONNREFUSED');
  });

  it('throws CHW_CHAIN_UNAVAILABLE when the request runs out of time', async () => {
    const { fetch } = fakeFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const e = await rejection(ogmiosCall({ url: URL_, fetch }, 'submitTransaction', {}));
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios submitTransaction failed: no answer within 30 s');
  });

  it('never puts a header or the url into a message', async () => {
    const { fetch } = fakeFetch(new TypeError('fetch failed'), new Response('denied', { status: 401 }));
    const opts = { url: 'https://ogmios-secret-key.example.org', headers: { authorization: 'Bearer sekrit-token' }, fetch };
    for (const e of [await rejection(ogmiosCall(opts, 'queryNetwork/tip')), await rejection(ogmiosCall(opts, 'queryNetwork/tip'))]) {
      expect(e.message).not.toMatch(/sekrit|secret-key|example\.org/);
    }
  });

  it('says only request failed when fetch rejects without a cause code, its message can name the host or a header value', async () => {
    const { fetch } = fakeFetch(
      // What Node's fetch throws for a header value with a line break, the value included.
      new TypeError('Headers.append: "Bearer sekrit\ntoken" is an invalid header value.'),
      new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND ogmios-secret-key.example.org') }),
    );
    const opts = { url: 'https://ogmios-secret-key.example.org', fetch };
    for (let i = 0; i < 2; i++) {
      expect((await rejection(ogmiosCall(opts, 'queryNetwork/tip'))).message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryNetwork/tip failed: request failed');
    }
  });

  it('redacts every secret of the connection in a JSON-RPC error it returns and in a message it builds', async () => {
    const secret = 'sekrit-token';
    const { fetch } = fakeFetch(
      json({ jsonrpc: '2.0', method: 'submitTransaction', error: { code: 3005, message: `token ${secret} refused`, data: { header: `Bearer ${secret}`, [secret]: [secret, 7] } }, id: null }, 400),
      json({ jsonrpc: '2.0', method: 'queryLedgerState/utxo', error: { code: -32600, message: `bad ${secret}` }, id: null }, 400),
    );
    const opts = { url: URL_, fetch, secrets: [secret] };
    expect(await ogmiosCall(opts, 'submitTransaction', {})).toEqual({
      error: { code: 3005, message: 'token <redacted> refused', data: { header: 'Bearer <redacted>', '<redacted>': ['<redacted>', 7] } },
    });
    const e = await rejection(ogmiosProvider(opts).utxosAt(hexToBytes(ADDRESS_A_HEX)));
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: error -32600: bad <redacted>');
  });

  it('names the provider it was given, so a call through Koios says koios', async () => {
    const { fetch } = fakeFetch(new Response('', { status: 503 }));
    const e = await rejection(ogmiosCall({ url: URL_, fetch, provider: 'koios' }, 'submitTransaction', {}));
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: koios submitTransaction failed: HTTP 503');
  });

  it('chainUnavailable builds the same ChwError', () => {
    const e = chainUnavailable('ogmios', 'queryNetwork/tip', 'HTTP 502');
    expect(e).toBeInstanceOf(ChwError);
    expect(e).toMatchObject({ code: 'CHW_CHAIN_UNAVAILABLE', message: 'CHW_CHAIN_UNAVAILABLE: ogmios queryNetwork/tip failed: HTTP 502' });
    expect(chainUnavailable('koios', 'tip', 'HTTP 403, token abc', ['abc']).message).toBe('CHW_CHAIN_UNAVAILABLE: koios tip failed: HTTP 403, token <redacted>');
  });
});

describe('utxoFromOgmios', () => {
  const results = (name: string) => (JSON.parse(fixture(name)) as { result: unknown[] }).result;

  it('reads a recorded Ogmios 7 output of a base address', () => {
    expect(utxoFromOgmios(results('v7-utxo-by-address.json')[0])).toEqual({
      input: { txId: hexToBytes('4c3819269b1f5ad9d0c0824f9c90459cc93f6c3f4a45b67f6a155e21fc0a3bcf'), index: 0n },
      address: hexToBytes(ADDRESS_A_HEX),
      lovelace: 100_000_000_000n,
    });
  });

  it('reads a recorded Ogmios 6 output the same way', () => {
    expect(utxoFromOgmios(results('v6-utxo-by-address.json')[0])).toEqual({
      input: { txId: hexToBytes('51f9459b90a73fc422c51e78a33ef14f49c3bc339f152b1d87c1f0d433df9803'), index: 0n },
      address: hexToBytes('00b4c99c9e322bf595d1fb9c2b038644d5875da827e918fb8c7f8136f0894efafff81048f0c7cd440e25e32c6594d897901411698f2f9f9161'),
      lovelace: 100_000_000_000n,
    });
  });

  it('reads an enterprise address from bech32', () => {
    expect(bytesToHex(utxoFromOgmios(results('v7-utxo-by-ref.json')[0]).address)).toBe(`60${PAYMENT_A}`);
  });

  describe('outputs built after the v7 schema', () => {
    // The fixture holds the big integers unquoted, as Ogmios writes them.
    const parsed = (parseJsonBig(fixture('v7-utxo-full.json')) as { result: unknown[] }).result.map(utxoFromOgmios);

    it('keeps lovelace and asset quantities above 2^53 exact', () => {
      const u = parsed[0]!;
      expect(u.lovelace).toBe(45_000_000_000_000_000n);
      expect(utxoToConfig(u)).toEqual({
        txId: 'a1'.repeat(32),
        index: 0,
        addressHex: ADDRESS_A_HEX,
        lovelace: '45000000000000000',
        assets: {
          '5d0f747d4eb70739ff667eed99b934de3a3e5054fae1e368902078e3': '18446744073709551615',
          '5d0f747d4eb70739ff667eed99b934de3a3e5054fae1e368902078e3746f6b656e': '9007199254740993',
          b5ae663aaea8e500157bdf4baafd6f5ba0ce5759f7cd4101fc132f54706174617465: '1337',
        },
      });
    });

    it('reads an inline datum byte for byte and a datum hash', () => {
      expect(parsed[1]!.datum).toEqual({ kind: 'inline', cbor: hexToBytes('d8799f4568656c6c6fff') });
      expect(parsed[2]!.datum).toEqual({ kind: 'hash', hash: hexToBytes('a2f41fb6666ac8b15685760e8cde4fdac09b9b21778a9e47590f9a2688c08529') });
      expect(bytesToHex(parsed[1]!.address)).toBe(`70${plutusScript('v3_always_succeeds').hashHex}`);
      expect(parsed[3]!.datum).toBeUndefined();
    });

    it('wraps a Plutus reference script as [3, h\'<cbor>\'], which hashes to the script hash', () => {
      const script = plutusScript('v3_always_succeeds');
      const ref = parsed[3]!.scriptRef!;
      expect(bytesToHex(ref)).toBe(`8203585e${script.cborHex}`);
      expect(bytesToHex(scriptFromRef(ref).hash)).toBe(script.hashHex);
    });

    it('encodes a native reference script from its clauses, after is invalid_before and before is invalid_hereafter, same hash as CSL', () => {
      const pkh = CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(PAYMENT_A)));
      const list = (...scripts: CSL.NativeScript[]) => {
        const out = CSL.NativeScripts.new();
        for (const s of scripts) out.add(s);
        return out;
      };
      const all = CSL.NativeScript.new_script_all(CSL.ScriptAll.new(list(pkh, CSL.NativeScript.new_timelock_start(CSL.TimelockStart.new_timelockstart(CSL.BigNum.from_str('42'))))));
      const some = CSL.NativeScript.new_script_n_of_k(
        CSL.ScriptNOfK.new(1, list(pkh, CSL.NativeScript.new_timelock_expiry(CSL.TimelockExpiry.new_timelockexpiry(CSL.BigNum.from_str('18446744073709551615'))))),
      );
      expect(bytesToHex(parsed[4]!.scriptRef!)).toBe(`8200${all.to_hex()}`);
      expect(bytesToHex(scriptFromRef(parsed[4]!.scriptRef!).hash)).toBe(all.hash().to_hex());
      expect(bytesToHex(parsed[5]!.scriptRef!)).toBe(`8200${some.to_hex()}`);
      expect(bytesToHex(scriptFromRef(parsed[5]!.scriptRef!).hash)).toBe('6b2a517660be1467de0eb927e58138e01b70470392a3bda22abbd646');
      expect(all.hash().to_hex()).toBe('3d7b5aea5aa9c907f89dab8719faa04daeda4a5181a766bc324e1cad');
      expect(some.hash().to_hex()).toBe('6b2a517660be1467de0eb927e58138e01b70470392a3bda22abbd646');
    });

    it('keeps the cbor of a native script exactly as Ogmios sent it, the hash follows those bytes', () => {
      const ref = parsed[6]!.scriptRef!;
      expect(bytesToHex(ref)).toBe(`8200${'82019f8200581c77da02be0024494694a26dd63651314e60eb915c3f3431d63e0f63008204182aff'}`);
      expect(bytesToHex(scriptFromRef(ref).hash)).toBe('685fe66bebdaa50287ed91e2c6ee6580528827bf46a1c742da18ef2e');
    });
  });

  it('reads a Byron address from base58', () => {
    const utxo = utxoFromOgmios({
      transaction: { id: 'd4'.repeat(32) },
      index: 3,
      address: 'DdzFFzCqrht8mbSTZHqpM2u4HeND2mdspsaBhdQ1BowPJBMzbDeBMeKgqdoKqo1D4sdPusEdZJVrFJRBBxX1jUEofNDYCJSZLg8MkyCE',
      value: { ada: { lovelace: 1 } },
    });
    expect(bytesToHex(utxo.address)).toBe(
      '82d818584283581cdd94caac8641138040ceddb1af8ca5f733cce6dbde251d61c40eddfca101581e581cbb48f0cd98ee6f8724b90dc5310fbfb6ffe4d5f04b1e9585d4f0599d001af5dcb503',
    );
    expect(isByronAddress(utxo.address)).toBe(true);
    expect(utxo.input.index).toBe(3n);
  });

  const base = { transaction: { id: 'e5'.repeat(32) }, index: 0, address: ADDRESS_A_BECH32, value: { ada: { lovelace: 1 } } };
  it.each([
    ['a missing value', { ...base, value: undefined }, /value must be an object/],
    ['a missing lovelace amount', { ...base, value: {} }, /value\.ada\.lovelace must be an integer/],
    ['a fractional lovelace amount', { ...base, value: { ada: { lovelace: 1.5 } } }, /lovelace must be an integer/],
    ['a zero asset quantity', { ...base, value: { ada: { lovelace: 1 }, ['ab'.repeat(28)]: { '': 0 } } }, /between 1 and 2\^64 - 1/],
    ['an asset quantity above 2^64 - 1', { ...base, value: { ada: { lovelace: 1 }, ['ab'.repeat(28)]: { '': '18446744073709551616' } } }, /between 1 and 2\^64 - 1/],
    ['a short policy id', { ...base, value: { ada: { lovelace: 1 }, abcd: { '': 1 } } }, /policy id/],
    ['a short transaction id', { ...base, transaction: { id: 'ab' } }, /transaction\.id/],
    ['an address that is neither bech32 nor base58', { ...base, address: 'addr_test1notbech32' }, /./],
    ['a Plutus V4 script', { ...base, script: { language: 'plutus:v4', cbor: '4e4d01000033222220051200120011' } }, /plutus:v4 is not supported/],
    ['a guard clause', { ...base, script: { language: 'native', json: { clause: 'guard', from: 'ab'.repeat(28) } } }, /clause guard is not supported/],
    ['a Plutus script without cbor', { ...base, script: { language: 'plutus:v3' } }, /plutus:v3 script cbor must be hex/],
  ])('throws a plain Error for %s', (_name, json, message) => {
    let thrown: unknown;
    try {
      utxoFromOgmios(json);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ChwError);
    expect((thrown as Error).message).toMatch(message);
  });
});

describe('ogmiosProvider', () => {
  it('is named ogmios', () => {
    expect(ogmiosProvider({ url: URL_ }).name).toBe('ogmios');
  });

  it.each([
    ['Ogmios 7', 'v7-genesis-shelley.json'],
    ['Ogmios 6', 'v6-genesis-shelley.json'],
  ])('networkId reads network testnet from the Shelley genesis of %s as 0', async (_name, file) => {
    const { fetch, calls } = fakeFetch(answer(file));
    expect(await ogmiosProvider({ url: URL_, fetch }).networkId()).toBe(0);
    expect(calls[0]!.body).toMatchObject({ method: 'queryNetwork/genesisConfiguration', params: { era: 'shelley' } });
  });

  it('networkId reads network mainnet as 1 and refuses anything else', async () => {
    const { fetch } = fakeFetch(
      json({ jsonrpc: '2.0', method: 'queryNetwork/genesisConfiguration', result: { era: 'shelley', network: 'mainnet', networkMagic: 764824073 }, id: null }),
      json({ jsonrpc: '2.0', method: 'queryNetwork/genesisConfiguration', result: { era: 'shelley', networkMagic: 1 }, id: null }),
    );
    const provider = ogmiosProvider({ url: URL_, fetch });
    expect(await provider.networkId()).toBe(1);
    const e = await rejection(provider.networkId());
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryNetwork/genesisConfiguration failed: unexpected answer: network must be mainnet or testnet, got undefined');
  });

  it('utxosAt queries the bech32 form of the address and reads the outputs', async () => {
    const { fetch, calls } = fakeFetch(answer('v7-utxo-by-address.json'));
    const utxos = await ogmiosProvider({ url: URL_, fetch }).utxosAt(hexToBytes(ADDRESS_A_HEX));
    expect(calls[0]!.body).toEqual({ jsonrpc: '2.0', method: 'queryLedgerState/utxo', params: { addresses: [ADDRESS_A_BECH32] }, id: null });
    expect(utxos.map((u) => `${bytesToHex(u.input.txId)}#${u.input.index}`)).toEqual(['4c3819269b1f5ad9d0c0824f9c90459cc93f6c3f4a45b67f6a155e21fc0a3bcf#0']);
  });

  it('unspentOutputs queries output references and returns what Ogmios found', async () => {
    const { fetch, calls } = fakeFetch(answer('v7-utxo-by-ref.json'));
    const inputs = [
      { txId: hexToBytes('2ef47ca7b7a642a543e1d24bd6201604389b827845c5437d5a34de20839846a8'), index: 0n },
      { txId: hexToBytes('4c3819269b1f5ad9d0c0824f9c90459cc93f6c3f4a45b67f6a155e21fc0a3bcf'), index: 0n },
      { txId: hexToBytes('ff'.repeat(32)), index: 7n },
    ];
    const utxos = await ogmiosProvider({ url: URL_, fetch }).unspentOutputs(inputs);
    expect(calls[0]!.body.params).toEqual({
      outputReferences: [
        { transaction: { id: '2ef47ca7b7a642a543e1d24bd6201604389b827845c5437d5a34de20839846a8' }, index: 0 },
        { transaction: { id: '4c3819269b1f5ad9d0c0824f9c90459cc93f6c3f4a45b67f6a155e21fc0a3bcf' }, index: 0 },
        { transaction: { id: 'ff'.repeat(32) }, index: 7 },
      ],
    });
    expect(utxos.map((u) => [bytesToHex(u.address), u.lovelace])).toEqual([
      [`60${PAYMENT_A}`, 50_000_000_000n],
      [ADDRESS_A_HEX, 100_000_000_000n],
    ]);
  });

  it('unspentOutputs of no inputs asks nothing', async () => {
    const { fetch, calls } = fakeFetch();
    expect(await ogmiosProvider({ url: URL_, fetch }).unspentOutputs([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a registered key, Ogmios 7 list', 'v7-reward-registered.json', STAKE_A, true],
    ['a registered key, Ogmios 6 list', 'v6-reward-registered.json', '894efafff81048f0c7cd440e25e32c6594d897901411698f2f9f9161', true],
    ['another key than the listed one', 'v7-reward-registered.json', '894efafff81048f0c7cd440e25e32c6594d897901411698f2f9f9161', false],
    ['an unregistered key, Ogmios 7', 'v7-reward-unregistered.json', STAKE_A, false],
    ['an unregistered key, Ogmios 6', 'v6-reward-unregistered.json', STAKE_A, false],
    ['a registered key, map before Ogmios 6.13', 'v6-reward-map.json', STAKE_A, true],
    ['an unregistered key, map before Ogmios 6.13', 'v6-reward-map.json', '894efafff81048f0c7cd440e25e32c6594d897901411698f2f9f9161', false],
  ])('stakeRegistered: %s', async (_name, file, credential, registered) => {
    const { fetch, calls } = fakeFetch(answer(file));
    expect(await ogmiosProvider({ url: URL_, fetch }).stakeRegistered(hexToBytes(credential))).toBe(registered);
    expect(calls[0]!.body).toMatchObject({ method: 'queryLedgerState/rewardAccountSummaries', params: { keys: [credential] } });
  });

  it('a query answered with a JSON-RPC error is CHW_CHAIN_UNAVAILABLE with code and message', async () => {
    const { fetch } = fakeFetch(json({ jsonrpc: '2.0', method: 'queryLedgerState/utxo', error: { code: -32600, message: 'Invalid request: Error in $.params: unknown query name.' }, id: null }, 400));
    const e = await rejection(ogmiosProvider({ url: URL_, fetch }).utxosAt(hexToBytes(ADDRESS_A_HEX)));
    expect(e.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: error -32600: Invalid request: Error in $.params: unknown query name.');
  });

  it('an answer of the wrong shape is CHW_CHAIN_UNAVAILABLE naming what was wrong', async () => {
    const { fetch } = fakeFetch(json({ jsonrpc: '2.0', result: { utxo: [] }, id: null }), json({ jsonrpc: '2.0', result: [{ transaction: { id: 'ab' }, index: 0 }], id: null }));
    const provider = ogmiosProvider({ url: URL_, fetch });
    expect((await rejection(provider.utxosAt(hexToBytes(ADDRESS_A_HEX)))).message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: unexpected answer: result must be a list');
    expect((await rejection(provider.utxosAt(hexToBytes(ADDRESS_A_HEX)))).message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: unexpected answer: utxo transaction.id must be 32 bytes of hex');
  });

  it('a script language named like an inherited Object key is as unsupported as any unknown language', async () => {
    const utxo = (language: string) => ({ transaction: { id: 'e5'.repeat(32) }, index: 0, address: ADDRESS_A_BECH32, value: { ada: { lovelace: 1 } }, script: { language, cbor: '4e4d01000033222220051200120011' } });
    const { fetch } = fakeFetch(json({ jsonrpc: '2.0', result: [utxo('plutus:v4')], id: null }), json({ jsonrpc: '2.0', result: [utxo('constructor')], id: null }));
    const provider = ogmiosProvider({ url: URL_, fetch });
    const unknown = await rejection(provider.utxosAt(hexToBytes(ADDRESS_A_HEX)));
    const inherited = await rejection(provider.utxosAt(hexToBytes(ADDRESS_A_HEX)));
    expect(unknown.message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios queryLedgerState/utxo failed: unexpected answer: script language plutus:v4 is not supported');
    expect(inherited.message).toBe(unknown.message.replace('plutus:v4', 'constructor'));
  });

  it('submit sends the exact bytes as lower case hex and returns the id Ogmios reports', async () => {
    const { fetch, calls } = fakeFetch(answer('v7-submit-ok.json'));
    const result = await ogmiosProvider({ url: URL_, fetch }).submit(Uint8Array.of(0x84, 0xa0, 0xa0, 0xf5, 0xf6));
    expect(calls[0]!.body).toEqual({ jsonrpc: '2.0', method: 'submitTransaction', params: { transaction: { cbor: '84a0a0f5f6' } }, id: null });
    expect(result).toEqual({ ok: true, txId: hexToBytes('eaacde39b5578ab547458e3a4db4ffe57f4b4808e7dd503f7d9e60b1c7dd90d6') });
  });

  it.each([
    ['Ogmios 7, fee too small', 'v7-submit-fee-too-small.json', 3122, { minimumRequiredFee: { ada: { lovelace: 165149 } }, providedFee: { ada: { lovelace: 1000 } } }],
    [
      'Ogmios 6, unknown input',
      'v6-submit-bad-inputs.json',
      3117,
      { unknownOutputReferences: [{ transaction: { id: '51f9459b90a73fc422c51e78a33ef14f49c3bc339f152b1d87c1f0d433df9803' }, index: 0 }] },
    ],
  ])('submit returns a refusal as the Ogmios error, %s', async (_name, file, code, data) => {
    const { fetch } = fakeFetch(answer(file, 400));
    const result = await ogmiosProvider({ url: URL_, fetch }).submit(Uint8Array.of(0x80));
    expect(result).toEqual({ ok: false, error: { code, message: expect.any(String), data } });
  });

  it('submit throws CHW_CHAIN_UNAVAILABLE for a JSON-RPC error below 0, no ledger judged the transaction', async () => {
    const message = "Invalid transaction; It looks like the given transaction wasn't well-formed.";
    const { fetch } = fakeFetch(json({ jsonrpc: '2.0', method: 'submitTransaction', error: { code: -32602, message }, id: null }, 400));
    const e = await rejection(ogmiosProvider({ url: URL_, fetch }).submit(Uint8Array.of(0x80)));
    expect(e.message).toBe(`CHW_CHAIN_UNAVAILABLE: ogmios submitTransaction failed: error -32602: ${message}`);
  });

  it('submit throws CHW_CHAIN_UNAVAILABLE when the transport fails, and works again on the next call', async () => {
    const { fetch } = fakeFetch(new Response('', { status: 503 }), answer('v7-submit-ok.json'));
    const provider = ogmiosProvider({ url: URL_, fetch });
    expect((await rejection(provider.submit(Uint8Array.of(0x80)))).message).toBe('CHW_CHAIN_UNAVAILABLE: ogmios submitTransaction failed: HTTP 503');
    expect(await provider.submit(Uint8Array.of(0x80))).toMatchObject({ ok: true });
  });
});
