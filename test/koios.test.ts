import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { rewardAddressBytes, toBech32 } from '../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { parseTransaction, type TxInput } from '../src/core/cbor/tx.js';
import { ChwError } from '../src/core/errors.js';
import { KOIOS_URLS, koiosProvider, utxoFromKoios } from '../src/host/chain/koios.js';
import { rejectionInfo } from '../src/host/chain/ogmios-errors.js';
import { rejectionOf } from './helpers/page.js';

// Koios preprod answers, see test/fixtures/koios/README.md.

const BASE = 'https://preprod.koios.rest/api/v1';
const SCRIPT_ADDRESS = 'addr_test1wzsts6yutmfpkwwzjnyj9mvg46z9ss05g3tgpr5mxs2kgxcrge4zt';
const WALLET_ADDRESS = 'addr_test1qz2npwh56z2ehvp262enudgs3c09qxhhq6upyp6gll63scqem35amwujdn9cd0epxepgm8xvfta79t6salk7ztgwvc5sac7mjq';
const REGISTERED = 'stake_test1updaungfmrqlw3002699vv6mcsg24eqj3nffd6aqyccjkjc0ltamt';
const NOT_REGISTERED = 'stake_test1uqvac6wahwfxejuxhusnvs5dnnxy47lz4agwlm0p958xv2g2n0n9g';
const B598 = 'b598e9540c2d20f435998c01d460c66eb582c122b51d56d53516bec9596d2fed';
const SPENT = '66acde3559af86707bc6581992487b09e963aafaaf0156af580ec6a4691e80d7';
const TX_2BC0 = '2bc0430092e6e5795f61be4e2fb979c9cf7352a852ac40b7b5488024eee22ab0';
const TOKEN = 'koios-test-token-6d1f';

const fixture = (name: string) => readFileSync(`test/fixtures/koios/${name}`, 'utf8');
const rows = (name: string) => JSON.parse(fixture(name)) as Array<Record<string, unknown>>;
const TX_HEX = fixture('ogmios-submit-unknown-input.tx.hex').trim();
/** Address or reward address bytes of a bech32 string. */
const bytesOf = (text: string) => bech32.fromWords(bech32.decode(text as `${string}1${string}`, false).words);
const input = (txId: string, index: bigint): TxInput => ({ txId: hexToBytes(txId), index });

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const plain = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
/** A recorded /ogmios answer, with the id of the request it answers. */
const ogmiosAnswer = (name: string, request: { id?: unknown }, status: number, edit: (text: string) => string = (t) => t) =>
  json(edit(fixture(name)).replace(/"id":\s*(null|\d+)\s*}\s*$/, `"id":${JSON.stringify(request.id ?? null)}}`), status);

type Route = (url: URL, body: any) => Response | Promise<Response>;

/** Answers like Koios preprod from the fixtures, each filtered by what the request asks for. */
const preprod: Route = (url, body) => {
  const outpoint = (row: Record<string, unknown>) => `${row['tx_hash']}#${row['tx_index']}`;
  switch (url.pathname.replace('/api/v1/', '')) {
    case 'address_utxos':
      return json([...rows('address_utxos-script.json'), ...rows('address_utxos-wallet.json')].filter((r) => body._addresses.includes(r['address'])));
    case 'utxo_info':
      return json(rows('utxo_info-mixed.json').filter((r) => body._utxo_refs.includes(outpoint(r))));
    case 'account_info':
      return json(rows('account_info.json').filter((r) => body._stake_addresses.includes(r['stake_address'])));
    case 'tip':
      return json(rows('tip.json'));
    case 'ogmios':
      if (body.method === 'queryNetwork/genesisConfiguration') return ogmiosAnswer('ogmios-genesis-shelley.json', body, 200);
      if (body.params?.transaction?.cbor === '80') return ogmiosAnswer('ogmios-submit-invalid.json', body, 400);
      return ogmiosAnswer('ogmios-submit-unknown-input.json', body, 400);
    default:
      return plain(fixture('error-not-found.txt'), 404);
  }
};

interface Sent {
  method: string | undefined;
  url: URL;
  headers: Headers;
  body: any;
  signal: AbortSignal | null | undefined;
}

/** A fetch that answers through route and records every request. */
function koios(route: Route = preprod) {
  const sent: Sent[] = [];
  const fetch = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ method: init?.method, url, headers: new Headers(init?.headers), body, signal: init?.signal });
    return route(url, body);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

/** The rejection of a promise that must reject. */
const failure = async (promise: Promise<unknown>): Promise<Error> => (await rejectionOf(promise)) as Error;

describe('Koios provider', () => {
  it('talks to the public Koios of each network unless a url is given', async () => {
    expect(KOIOS_URLS).toEqual({
      mainnet: 'https://api.koios.rest/api/v1',
      preprod: 'https://preprod.koios.rest/api/v1',
      preview: 'https://preview.koios.rest/api/v1',
    });
    for (const network of ['mainnet', 'preprod', 'preview'] as const) {
      const { fetch, sent } = koios(() => json([]));
      await koiosProvider({ network, fetch }).unspentOutputs([input(B598, 0n)]);
      expect(sent[0]!.url.toString()).toBe(`${KOIOS_URLS[network]}/utxo_info`);
    }
    const { fetch, sent } = koios(() => json([]));
    const provider = koiosProvider({ network: 'preprod', url: 'http://localhost:8053/api/v1/', fetch });
    await provider.unspentOutputs([input(B598, 0n)]);
    expect(sent[0]!.url.toString()).toBe('http://localhost:8053/api/v1/utxo_info');
    expect(provider.name).toBe('koios');
  });

  it('reads the UTxOs at an address with inline datums, reference scripts and assets', async () => {
    const { fetch, sent } = koios();
    const utxos = await koiosProvider({ network: 'preprod', fetch }).utxosAt(bytesOf(SCRIPT_ADDRESS));
    expect(sent[0]!.url.toString()).toBe(`${BASE}/address_utxos?order=tx_hash.asc,tx_index.asc&offset=0&limit=1000`);
    expect(sent[0]!.body).toEqual({ _addresses: [SCRIPT_ADDRESS], _extended: true });
    expect(sent[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(utxos).toHaveLength(4);
    expect(utxos.find((u) => bytesToHex(u.input.txId) === TX_2BC0 && u.input.index === 1n)).toEqual({
      input: input(TX_2BC0, 1n),
      address: bytesOf(SCRIPT_ADDRESS),
      lovelace: 1254210n,
      assets: new Map([['41f08518e801ca998fc0536422c8760580bc40d95fe1c5f272d0ffe5', new Map([['3431', 1n]])]]),
      // Koios also sends a datum_hash for an inline datum, the inline datum counts.
      datum: { kind: 'inline', cbor: hexToBytes('9f1829581c41f08518e801ca998fc0536422c8760580bc40d95fe1c5f272d0ffe5ff') },
      scriptRef: hexToBytes('82024746010000224981'),
    });
  });

  it('gives the datums and script references byte for byte as the transactions wrote them', async () => {
    const txs = JSON.parse(fixture('tx_cbor.json')) as Array<{ tx_hash: string; cbor: string }>;
    const outputsOf = (hash: string) => parseTransaction(hexToBytes(txs.find((t) => t.tx_hash === hash)!.cbor)).body.outputs;
    const provider = koiosProvider({ network: 'preprod', fetch: koios().fetch });

    const atScript = await provider.utxosAt(bytesOf(SCRIPT_ADDRESS));
    const created = outputsOf(TX_2BC0).slice(0, 3);
    created.forEach((output, i) => {
      expect(atScript.find((u) => bytesToHex(u.input.txId) === TX_2BC0 && u.input.index === BigInt(i))).toEqual({ ...output, input: input(TX_2BC0, BigInt(i)) });
    });

    const [hashed] = await provider.unspentOutputs([input(B598, 0n)]);
    expect(hashed).toEqual({ ...outputsOf(B598)[0]!, input: input(B598, 0n) });
    expect(hashed!.datum).toEqual({ kind: 'hash', hash: hexToBytes('923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec') });
    expect(bytesToHex(hashed!.scriptRef!)).toBe('82024746010000222499');
  });

  it('pages through an address with more than 1000 UTxOs between two reads of the same tip', async () => {
    const template = rows('address_utxos-wallet.json')[1]!;
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ ...template, tx_index: from + i }));
    const { fetch, sent } = koios((url) => {
      if (url.pathname.endsWith('/tip')) return json(rows('tip.json'));
      return json(url.searchParams.get('offset') === '0' ? page(0, 1000) : page(1000, 1));
    });
    const utxos = await koiosProvider({ network: 'preprod', token: TOKEN, fetch }).utxosAt(bytesOf(WALLET_ADDRESS));
    expect(utxos).toHaveLength(1001);
    expect(utxos[1000]!.input.index).toBe(1000n);
    // The first page is full, so the listing is read again from offset 0 between two reads of the tip.
    expect(sent.map((s) => [s.method, s.url.pathname.split('/').pop(), s.url.searchParams.get('offset')])).toEqual([
      ['POST', 'address_utxos', '0'],
      ['GET', 'tip', null],
      ['POST', 'address_utxos', '0'],
      ['POST', 'address_utxos', '1000'],
      ['GET', 'tip', null],
    ]);
    for (const s of sent.filter((s) => s.url.pathname.endsWith('/address_utxos'))) {
      expect([s.url.searchParams.get('limit'), s.url.searchParams.get('order')]).toEqual(['1000', 'tx_hash.asc,tx_index.asc']);
    }
    expect(sent[1]!.body).toBeUndefined();
    for (const s of sent) expect(s.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reads the listing again when a block moves the outputs between two pages', async () => {
    const template = rows('address_utxos-wallet.json')[1]!;
    const tipRow = rows('tip.json')[0]!;
    let stock = Array.from({ length: 1001 }, (_, i) => ({ ...template, tx_index: i }));
    let block = 0;
    let pages = 0;
    const { fetch } = koios((url) => {
      if (url.pathname.endsWith('/tip')) return json([{ ...tipRow, hash: block.toString(16).padStart(64, '0') }]);
      const offset = Number(url.searchParams.get('offset'));
      const page = stock.slice(offset, offset + 1000);
      // Right after the first page of the first listing a block spends output 0, every later output moves up one offset.
      if (++pages === 2) {
        stock = stock.slice(1);
        block++;
      }
      return json(page);
    });
    const utxos = await koiosProvider({ network: 'preprod', fetch }).utxosAt(bytesOf(WALLET_ADDRESS));
    // Without the second listing output 0 would still show and output 1000 would be missing.
    expect(utxos.map((u) => Number(u.input.index))).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it('gives up with CHW_CHAIN_UNAVAILABLE after three listings that each saw the tip move', async () => {
    const template = rows('address_utxos-wallet.json')[1]!;
    const tipRow = rows('tip.json')[0]!;
    let block = 0;
    const { fetch, sent } = koios((url) => {
      if (url.pathname.endsWith('/tip')) return json([{ ...tipRow, hash: (block++).toString(16).padStart(64, '0') }]);
      const offset = Number(url.searchParams.get('offset'));
      return json(Array.from({ length: offset === 0 ? 1000 : 1 }, (_, i) => ({ ...template, tx_index: offset + i })));
    });
    const error = await failure(koiosProvider({ network: 'preprod', fetch }).utxosAt(bytesOf(WALLET_ADDRESS)));
    expect(error).toBeInstanceOf(ChwError);
    expect(error.message).toBe('CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: address listing kept changing');
    expect(sent.filter((s) => s.url.pathname.endsWith('/tip'))).toHaveLength(6);
  });

  it('refuses a tip without a block hash', async () => {
    const template = rows('address_utxos-wallet.json')[1]!;
    const { fetch } = koios((url) => (url.pathname.endsWith('/tip') ? json([{}]) : json(Array.from({ length: 1000 }, (_, i) => ({ ...template, tx_index: i })))));
    await expect(koiosProvider({ network: 'preprod', fetch }).utxosAt(bytesOf(WALLET_ADDRESS))).rejects.toThrow(
      'CHW_CHAIN_UNAVAILABLE: koios tip failed: unexpected answer: the tip must name a block hash',
    );
  });

  it('returns only unspent outpoints and asks for them in groups of 40', async () => {
    const { fetch, sent } = koios();
    const provider = koiosProvider({ network: 'preprod', fetch });
    const unknown = input('00'.repeat(32), 0n);
    const found = await provider.unspentOutputs([input(B598, 0n), input(SPENT, 0n), unknown]);
    expect(sent[0]!.body).toEqual({ _utxo_refs: [`${B598}#0`, `${SPENT}#0`, `${'00'.repeat(32)}#0`], _extended: true });
    // The spent output comes back with is_spent true, the unknown one not at all.
    expect(rows('utxo_info-mixed.json').map((r) => [r['tx_hash'], r['is_spent']])).toEqual([
      [B598, false],
      [SPENT, true],
    ]);
    expect(found.map((u) => `${bytesToHex(u.input.txId)}#${u.input.index}`)).toEqual([`${B598}#0`]);

    const many = koios(() => json([]));
    const inputs = Array.from({ length: 85 }, (_, i) => input(B598, BigInt(i)));
    expect(await koiosProvider({ network: 'preprod', fetch: many.fetch }).unspentOutputs([...inputs, input(B598, 3n)])).toEqual([]);
    expect(many.sent.map((s) => s.body._utxo_refs.length)).toEqual([40, 40, 5]);

    const none = koios();
    expect(await koiosProvider({ network: 'preprod', fetch: none.fetch }).unspentOutputs([])).toEqual([]);
    expect(none.sent).toHaveLength(0);
  });

  it('reads the stake registration from account_info', async () => {
    const { fetch, sent } = koios();
    const provider = koiosProvider({ network: 'preprod', fetch });
    expect(await provider.stakeRegistered(bytesOf(REGISTERED).slice(1))).toBe(true);
    expect(sent[0]!.body).toEqual({ _stake_addresses: [REGISTERED] });
    expect(await provider.stakeRegistered(bytesOf(NOT_REGISTERED).slice(1))).toBe(false);
    // A stake address Koios never saw comes back as an empty list.
    expect(rows('account_info-unknown.json')).toEqual([]);
    const neverSeen = new Uint8Array(28).fill(0x11);
    expect(await provider.stakeRegistered(neverSeen)).toBe(false);
    expect(sent[2]!.body).toEqual({ _stake_addresses: [toBech32(rewardAddressBytes(0, neverSeen))] });

    const mainnet = koios(() => json([]));
    await koiosProvider({ network: 'mainnet', fetch: mainnet.fetch }).stakeRegistered(neverSeen);
    expect(mainnet.sent[0]!.body._stake_addresses[0]).toBe(toBech32(rewardAddressBytes(1, neverSeen)));
    expect(mainnet.sent[0]!.body._stake_addresses[0].startsWith('stake1')).toBe(true);
  });

  it('reads the network from the Ogmios genesis configuration', async () => {
    const { fetch, sent } = koios();
    expect(await koiosProvider({ network: 'preprod', fetch }).networkId()).toBe(0);
    expect(sent[0]!.url.toString()).toBe(`${BASE}/ogmios`);
    expect(sent[0]!.body).toMatchObject({ jsonrpc: '2.0', method: 'queryNetwork/genesisConfiguration', params: { era: 'shelley' } });

    // The recorded answer with network and magic changed to those of mainnet.
    const mainnet = koios((_url, body) =>
      ogmiosAnswer('ogmios-genesis-shelley.json', body, 200, (t) => t.replace('"network":"testnet"', '"network":"mainnet"').replace('"networkMagic":1,', '"networkMagic":764824073,')),
    );
    expect(await koiosProvider({ network: 'mainnet', fetch: mainnet.fetch }).networkId()).toBe(1);
    const odd = koios((_url, body) => ogmiosAnswer('ogmios-genesis-shelley.json', body, 200, (t) => t.replace('"network":"testnet"', '"network":"devnet"')));
    await expect(koiosProvider({ network: 'preprod', fetch: odd.fetch }).networkId()).rejects.toThrow(
      'CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: unexpected answer: network must be mainnet or testnet, got devnet',
    );
  });

  it('refuses a url that serves another network than the options name, by its network magic', async () => {
    // The recorded preprod answer, magic 1, behind a provider configured for preview.
    const preview = await failure(koiosProvider({ network: 'preview', fetch: koios().fetch }).networkId());
    expect(preview).toBeInstanceOf(ChwError);
    expect((preview as ChwError).code).toBe('CHW_CHAIN_UNAVAILABLE');
    expect(preview.message).toBe(
      'CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: the url serves network magic 1 (preprod), ledger.chain.network preview has network magic 2',
    );
    const mainnet = await failure(koiosProvider({ network: 'mainnet', fetch: koios().fetch }).networkId());
    expect(mainnet.message).toBe(
      'CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: the url serves network magic 1 (preprod), ledger.chain.network mainnet has network magic 764824073',
    );
    const unknown = koios((_url, body) => ogmiosAnswer('ogmios-genesis-shelley.json', body, 200, (t) => t.replace('"networkMagic":1,', '"networkMagic":42,')));
    await expect(koiosProvider({ network: 'preprod', fetch: unknown.fetch }).networkId()).rejects.toThrow(
      'the url serves network magic 42 (an unknown network), ledger.chain.network preprod has network magic 1',
    );
  });

  it('submits the exact bytes and hands a refusal back as the Ogmios error, a JSON-RPC error below 0 is a transport failure', async () => {
    const { fetch, sent } = koios();
    const provider = koiosProvider({ network: 'preprod', fetch });
    const refused = await provider.submit(hexToBytes(TX_HEX));
    expect(sent[0]!.url.toString()).toBe(`${BASE}/ogmios`);
    expect(sent[0]!.body).toMatchObject({ jsonrpc: '2.0', method: 'submitTransaction', params: { transaction: { cbor: TX_HEX } } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(3997);
    expect(rejectionInfo(refused.error)).toBe('ConwayApplyTxError [ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"]');

    // Koios' Ogmios could not decode the bytes in any era, no ledger judged them.
    await expect(provider.submit(Uint8Array.of(0x80))).rejects.toThrow(
      /^CHW_CHAIN_UNAVAILABLE: koios submitTransaction failed: error -32602: Invalid transaction; It looks like the given transaction wasn't well-formed\./,
    );
  });

  it('returns the id of an accepted transaction', async () => {
    const accepted = koios((_url, body) => ogmiosAnswer('ogmios-submit-accepted.json', body, 200));
    const result = await koiosProvider({ network: 'preprod', fetch: accepted.fetch }).submit(hexToBytes(TX_HEX));
    expect(result).toEqual({ ok: true, txId: hexToBytes('eaacde39b5578ab547458e3a4db4ffe57f4b4808e7dd503f7d9e60b1c7dd90d6') });

    const bare = koios((_url, body) => json({ jsonrpc: '2.0', method: 'submitTransaction', result: {}, id: body.id ?? null }));
    await expect(koiosProvider({ network: 'preprod', fetch: bare.fetch }).submit(hexToBytes(TX_HEX))).rejects.toThrow(
      'CHW_CHAIN_UNAVAILABLE: koios submitTransaction failed: unexpected answer: result.transaction.id must be 32 bytes of hex',
    );
  });

  it('sends the token on every request and never puts it in a message', async () => {
    const { fetch, sent } = koios();
    const provider = koiosProvider({ network: 'preprod', token: TOKEN, fetch });
    await provider.utxosAt(bytesOf(WALLET_ADDRESS));
    await provider.unspentOutputs([input(B598, 0n)]);
    await provider.stakeRegistered(bytesOf(REGISTERED).slice(1));
    await provider.networkId();
    await provider.submit(hexToBytes(TX_HEX));
    expect(sent).toHaveLength(5);
    for (const s of sent) expect(s.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);

    const recorded = koios(() => plain(fixture('error-bad-token.txt'), 403));
    await expect(koiosProvider({ network: 'preprod', token: TOKEN, fetch: recorded.fetch }).utxosAt(bytesOf(WALLET_ADDRESS))).rejects.toThrow(
      'CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: HTTP 403, Unauthorized Auth Token, Please verify your token created from https://koios.rest/Profile.html',
    );
    // A server that echoes the token still yields a message without it, on REST and on /ogmios.
    const echo = koios(() => plain(`Unauthorized Auth Token ${TOKEN}`, 403));
    const echoing = koiosProvider({ network: 'preprod', token: TOKEN, fetch: echo.fetch });
    const rest = await failure(echoing.utxosAt(bytesOf(WALLET_ADDRESS)));
    expect(rest.message).toBe('CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: HTTP 403, Unauthorized Auth Token <redacted>');
    const ogmios = await failure(echoing.networkId());
    expect(ogmios.message).toBe('CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: HTTP 403');
    expect(ogmios.message).not.toContain(TOKEN);

    const anonymous = koios();
    await koiosProvider({ network: 'preprod', fetch: anonymous.fetch }).networkId();
    expect(anonymous.sent[0]!.headers.has('authorization')).toBe(false);
  });

  it('redacts a token the Ogmios behind /ogmios echoes in a JSON-RPC error, in the message and in a refusal', async () => {
    const { fetch } = koios((_url, body) =>
      json({ jsonrpc: '2.0', method: body.method, error: { code: 3005, message: `token ${TOKEN} has no access`, data: { token: TOKEN } }, id: body.id ?? null }, 400),
    );
    const provider = koiosProvider({ network: 'preprod', token: TOKEN, fetch });
    expect((await failure(provider.networkId())).message).toBe('CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: error 3005: token <redacted> has no access');
    const refused = await provider.submit(hexToBytes(TX_HEX));
    expect(refused).toEqual({ ok: false, error: { code: 3005, message: 'token <redacted> has no access', data: { token: '<redacted>' } } });
    if (refused.ok) return;
    expect(rejectionInfo(refused.error)).toBe('Ogmios 3005: token <redacted> has no access');
  });

  it('keeps a token with a line break out of the message when fetch refuses the header', async () => {
    const broken = 'koios-test\ntoken-6d1f';
    // koios() reads the headers with new Headers(), which refuses the value the way Node's fetch does and names it.
    const provider = koiosProvider({ network: 'preprod', token: broken, fetch: koios().fetch });
    expect((await failure(provider.utxosAt(bytesOf(WALLET_ADDRESS)))).message).toBe('CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: request failed');
    expect((await failure(provider.networkId())).message).toBe('CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: request failed');
  });

  it.each([
    ['a PostgREST error', () => json(fixture('error-postgrest-bad-arg.json'), 400), `HTTP 400, malformed array literal: "${SCRIPT_ADDRESS}"`],
    ['a body over the limit', () => plain(fixture('error-payload-too-large.txt'), 413), 'HTTP 413, Payload too large, body length was 8995. Please ensure your request body size is below 5120 bytes'],
    ['an unknown path', () => plain(fixture('error-not-found.txt'), 404), 'HTTP 404, Query not Found! Please verify syntax referring to examples from https://api.koios.rest'],
    ['a gateway error without body', () => new Response('', { status: 502 }), 'HTTP 502'],
    ['an answer that is no JSON', () => plain('<html>maintenance</html>', 200), 'HTTP 200 with a body that is not JSON'],
    ['an answer that is no list', () => json({ rows: [] }), 'unexpected answer: the body must be a list'],
    ['a failed connection', () => Promise.reject(new TypeError('fetch failed')), 'request failed'],
    [
      'a refused connection',
      () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) })),
      'request failed: ECONNREFUSED',
    ],
    ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'no answer within 30 s'],
  ] as const)('turns %s into CHW_CHAIN_UNAVAILABLE', async (_name, answer, reason) => {
    const error = await failure(koiosProvider({ network: 'preprod', fetch: koios(answer).fetch }).utxosAt(bytesOf(WALLET_ADDRESS)));
    expect(error).toBeInstanceOf(ChwError);
    expect((error as ChwError).code).toBe('CHW_CHAIN_UNAVAILABLE');
    expect(error.message).toBe(`CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: ${reason}`);
  });

  it('turns a method Koios does not forward into CHW_CHAIN_UNAVAILABLE', async () => {
    const { fetch } = koios(() => plain(fixture('error-ogmios-unknown-method.txt'), 403));
    const error = await failure(koiosProvider({ network: 'preprod', fetch }).networkId());
    expect((error as ChwError).code).toBe('CHW_CHAIN_UNAVAILABLE');
    expect(error.message).toBe('CHW_CHAIN_UNAVAILABLE: koios queryNetwork/genesisConfiguration failed: HTTP 403');
  });

  it('refuses a UTxO it cannot read instead of dropping it', async () => {
    const broken = { ...rows('address_utxos-wallet.json')[0]!, tx_hash: 'xyz' };
    const { fetch } = koios(() => json([broken]));
    await expect(koiosProvider({ network: 'preprod', fetch }).utxosAt(bytesOf(WALLET_ADDRESS))).rejects.toThrow(
      'CHW_CHAIN_UNAVAILABLE: koios address_utxos failed: unreadable UTxO xyz#0: tx_hash must be 32 bytes of hex',
    );
  });
});

describe('utxoFromKoios', () => {
  const row = rows('address_utxos-wallet.json')[0]!;

  it('reads lovelace and asset quantities past 2^53 exactly', () => {
    const asset = { policy_id: 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9', asset_name: '0014df10745553444d', quantity: '9007199254740993' };
    const utxo = utxoFromKoios({ ...row, value: '18446744073709551615', asset_list: [asset] });
    expect(utxo.lovelace).toBe(18446744073709551615n);
    expect(utxo.assets).toEqual(new Map([['e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9', new Map([['0014df10745553444d', 9007199254740993n]])]]));
    expect(utxoFromKoios({ ...row, value: 2000000 }).lovelace).toBe(2000000n);
    expect(() => utxoFromKoios({ ...row, value: '18446744073709551616' })).toThrow('value must be an integer from 0 to 2^64 - 1');
    expect(() => utxoFromKoios({ ...row, value: 2.5 })).toThrow('value must be an integer from 0 to 2^64 - 1');
  });

  it('reads the recorded wallet output with its asset and without datum or script', () => {
    expect(utxoFromKoios(row)).toEqual({
      input: input('17008d4a5727946439c443e7702f197ab51ca068e75b67b72e2df5953d930b8b', 0n),
      address: bytesOf(WALLET_ADDRESS),
      lovelace: 2000000n,
      assets: new Map([['e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9', new Map([['0014df10745553444d', 1001000000n]])]]),
    });
  });

  it('writes V3 and native reference scripts as script_ref holds them', () => {
    const v3 = utxoFromKoios({ ...row, reference_script: { hash: '00', size: 7, type: 'plutusV3', bytes: '46010000222499', value: null } });
    expect(bytesToHex(v3.scriptRef!)).toBe('82034746010000222499');
    // A native script is a CBOR array inside script_ref, not a byte string. Here [0, key hash], sig.
    const sig = `8200581c${'11'.repeat(28)}`;
    const native = utxoFromKoios({ ...row, reference_script: { hash: '00', size: null, type: 'timelock', bytes: sig, value: {} } });
    expect(bytesToHex(native.scriptRef!)).toBe(`8200${sig}`);
  });

  it('refuses what it cannot read', () => {
    expect(() => utxoFromKoios({ ...row, reference_script: { type: 'plutusV4', bytes: '46010000222499' } })).toThrow('unknown reference script type plutusV4');
    expect(() => utxoFromKoios({ ...row, reference_script: { type: 'constructor', bytes: '46010000222499' } })).toThrow('unknown reference script type constructor');
    expect(() => utxoFromKoios({ ...row, reference_script: { type: 'plutusV2', bytes: '' } })).toThrow('reference_script.bytes must be hex');
    expect(() => utxoFromKoios({ ...row, inline_datum: { bytes: 'ff' } })).toThrow('inline_datum.bytes must be the CBOR of plutus_data');
    expect(() => utxoFromKoios({ ...row, datum_hash: 'abcd' })).toThrow('datum_hash must be 32 bytes of hex');
    expect(() => utxoFromKoios({ ...row, asset_list: [{ policy_id: 'e675', asset_name: '', quantity: '1' }] })).toThrow('policy_id must be 28 bytes of hex');
    expect(() => utxoFromKoios({ ...row, asset_list: [{ policy_id: 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9', asset_name: '', quantity: '0' }] })).toThrow(
      'quantity must be an integer from 1 to 2^64 - 1',
    );
    expect(() => utxoFromKoios({ ...row, address: 'addr_test1qqqq' })).toThrow();
    expect(() => utxoFromKoios([])).toThrow('a UTxO must be an object');
  });
});
