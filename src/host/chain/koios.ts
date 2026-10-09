import { base58, bech32 } from '@scure/base';
import { rewardAddressBytes, toBech32 } from '../../core/addresses.js';
import { bytesToHex, concat, hexToBytes, isHex } from '../../core/bytes.js';
import { isPlutusDataBytes } from '../../core/cbor-shapes.js';
import { encode } from '../../core/cbor/encode.js';
import type { TxInput } from '../../core/cbor/tx.js';
import type { Utxo } from '../../core/ledger.js';
import { isScriptRef } from '../../core/scripts.js';
import { addAsset, MAX_UINT64, type MultiAsset } from '../../core/value.js';
import { jsonInteger, parseJsonBig } from './json.js';
import { CHAIN_TIMEOUT_MS, chainUnavailable, fetchFailure, ogmiosCall, ogmiosProvider, type OgmiosConnection } from './ogmios.js';
import type { ChainProvider } from './provider.js';

// Koios: UTxOs and stake accounts over its REST endpoints, network and submit
// over the Ogmios methods it forwards at /ogmios. Lovelace and asset quantities
// come as decimal strings. One answer holds at most PAGE rows and a request
// body at most 5120 bytes, so address queries page and outpoint queries go out
// in groups. Pages are separate queries, so a listing over several pages counts
// only when the chain tip stayed the same while it was read.

export const KOIOS_URLS: Record<'mainnet' | 'preprod' | 'preview', string> = Object.freeze({
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
});

/** The networkMagic of each network's Shelley genesis, so a URL of another network fails before the first test. */
const NETWORK_MAGIC = { mainnet: 764824073, preprod: 1, preview: 2 } as const;
/** The most rows Koios returns in one answer. */
const PAGE = 1000;
/** Outpoints per utxo_info request, about 3 KB of body. */
const REFS_PER_REQUEST = 40;
/** How often an address listing over several pages is read before a moving chain counts as a failure. */
const LISTING_ATTEMPTS = 3;
/** reference_script.type to the language tag of script = [tag, script]. */
const LANGUAGES = new Map<unknown, 0 | 1 | 2 | 3>([
  ['timelock', 0],
  ['multisig', 0],
  ['plutusV1', 1],
  ['plutusV2', 2],
  ['plutusV3', 3],
]);

type Row = Record<string, unknown>;

function record(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
}

/** A count as parseJsonBig leaves it, from min to 2^64 - 1. */
function natural(value: unknown, what: string, min = 0n): bigint {
  let n: bigint | undefined;
  try {
    n = jsonInteger(value, what);
  } catch {
    n = undefined;
  }
  if (n === undefined || n < min || n > MAX_UINT64) throw new Error(`${what} must be an integer from ${min} to 2^64 - 1`);
  return n;
}

/** Shelley addresses come as bech32, Byron addresses as base58. */
function addressBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new Error('address must be a string');
  if (value.startsWith('addr')) return bech32.fromWords(bech32.decode(value as `${string}1${string}`, false).words);
  return base58.decode(value);
}

function assetsOf(value: unknown): MultiAsset | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('asset_list must be an array');
  const assets: MultiAsset = new Map();
  for (const item of value) {
    const asset = record(item);
    const policy = asset?.['policy_id'];
    const name = asset?.['asset_name'] ?? '';
    if (!isHex(policy, 28)) throw new Error('policy_id must be 28 bytes of hex');
    if (!isHex(name) || name.length > 64) throw new Error('asset_name must be hex of at most 32 bytes');
    addAsset(assets, policy.toLowerCase(), name.toLowerCase(), natural(asset?.['quantity'], 'quantity', 1n));
  }
  return assets.size > 0 ? assets : undefined;
}

function datumOf(row: Row): Utxo['datum'] {
  const inline = row['inline_datum'];
  if (inline !== null && inline !== undefined) {
    const bytes = record(inline)?.['bytes'];
    if (!isHex(bytes) || bytes.length === 0 || !isPlutusDataBytes(hexToBytes(bytes))) throw new Error('inline_datum.bytes must be the CBOR of plutus_data');
    return { kind: 'inline', cbor: hexToBytes(bytes) };
  }
  // Koios also fills datum_hash for an inline datum, so the hash counts only without one.
  const hash = row['datum_hash'];
  if (hash === null || hash === undefined) return undefined;
  if (!isHex(hash, 32)) throw new Error('datum_hash must be 32 bytes of hex');
  return { kind: 'hash', hash: hexToBytes(hash) };
}

function scriptRefOf(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  const script = record(value);
  const language = LANGUAGES.get(script?.['type']);
  if (language === undefined) throw new Error(`unknown reference script type ${String(script?.['type'])}`);
  const bytes = script?.['bytes'];
  if (!isHex(bytes) || bytes.length === 0) throw new Error('reference_script.bytes must be hex');
  // A Plutus script sits in script_ref as a byte string, the bytes Koios sends. A native script
  // sits there as its CBOR array, which Koios sends as the bytes.
  const ref = language === 0 ? concat(Uint8Array.of(0x82, 0x00), hexToBytes(bytes)) : encode([BigInt(language), hexToBytes(bytes)]);
  if (!isScriptRef(ref)) throw new Error('reference_script does not read as a script');
  return ref;
}

/** Koios UTxO JSON (address_utxos and utxo_info with _extended) to the wallet's Utxo. */
export function utxoFromKoios(json: unknown): Utxo {
  const row = record(json);
  if (!row) throw new Error('a UTxO must be an object');
  const txHash = row['tx_hash'];
  if (!isHex(txHash, 32)) throw new Error('tx_hash must be 32 bytes of hex');
  const utxo: Utxo = {
    input: { txId: hexToBytes(txHash), index: natural(row['tx_index'], 'tx_index') },
    address: addressBytes(row['address']),
    lovelace: natural(row['value'], 'value'),
  };
  const assets = assetsOf(row['asset_list']);
  if (assets) utxo.assets = assets;
  const datum = datumOf(row);
  if (datum) utxo.datum = datum;
  const scriptRef = scriptRefOf(row['reference_script']);
  if (scriptRef) utxo.scriptRef = scriptRef;
  return utxo;
}

/** The readable part of an error body: the message of a PostgREST error, else the first line of the text, at most 200 characters. */
function reason(text: string): string {
  let message: unknown;
  try {
    message = record(JSON.parse(text))?.['message'];
  } catch {
    message = undefined;
  }
  const line = (typeof message === 'string' ? message : text).split('\n')[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

const unspent = (row: unknown) => record(row)?.['is_spent'] !== true;
const outpointOf = (row: unknown) => `${String(record(row)?.['tx_hash'])}#${String(record(row)?.['tx_index'])}`;
const refOf = (input: TxInput) => `${bytesToHex(input.txId)}#${input.index}`;

/** A Koios backed ChainProvider for mainnet, preprod or preview. */
export function koiosProvider(opts: { network: 'mainnet' | 'preprod' | 'preview'; url?: string; token?: string; fetch?: typeof fetch }): ChainProvider {
  const base = (opts.url ?? KOIOS_URLS[opts.network]).replace(/\/+$/, '');
  // Looked up per call, so a fetch replaced after the provider was built still counts.
  const doFetch: typeof fetch = (input, init) => (opts.fetch ?? fetch)(input, init);
  const networkId: 0 | 1 = opts.network === 'mainnet' ? 1 : 0;
  const headers: Record<string, string> = opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` };
  // An error body may echo the token, so every message and every forwarded JSON-RPC error has it redacted.
  const secrets = opts.token === undefined ? [] : [opts.token];
  // Network and submit go to the Ogmios behind /ogmios, with the Ogmios client and its messages under the name koios.
  const forwarded: OgmiosConnection = { url: `${base}/ogmios`, headers, fetch: doFetch, provider: 'koios', secrets };
  const ogmios = ogmiosProvider(forwarded);
  const unavailable = (endpoint: string, why: string) => chainUnavailable('koios', endpoint, why, secrets);

  /** POST with a JSON body, or GET without one. */
  async function request(endpoint: string, body?: unknown, query = ''): Promise<unknown[]> {
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${base}/${endpoint}${query}`, {
        ...(body === undefined
          ? { method: 'GET', headers: { ...headers, accept: 'application/json' } }
          : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      throw unavailable(endpoint, fetchFailure(error));
    }
    if (response.status !== 200) {
      const why = reason(text);
      throw unavailable(endpoint, why ? `HTTP ${response.status}, ${why}` : `HTTP ${response.status}`);
    }
    let json: unknown;
    try {
      json = parseJsonBig(text);
    } catch {
      throw unavailable(endpoint, 'HTTP 200 with a body that is not JSON');
    }
    if (!Array.isArray(json)) throw unavailable(endpoint, 'unexpected answer: the body must be a list');
    return json;
  }

  /** The hash of the block at the tip, to tell whether the chain moved between two reads. */
  async function tip(): Promise<string> {
    const [row] = await request('tip');
    const hash = record(row)?.['hash'];
    if (!isHex(hash, 32)) throw unavailable('tip', 'unexpected answer: the tip must name a block hash');
    return hash;
  }

  /** Every page of address_utxos from offset 0, until a page has fewer than PAGE rows. */
  async function listing(query: unknown): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await request('address_utxos', query, `?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=${PAGE}`);
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  function utxos(endpoint: string, rows: unknown[]): Utxo[] {
    return rows.filter(unspent).map((row) => {
      try {
        return utxoFromKoios(row);
      } catch (error) {
        throw unavailable(endpoint, `unreadable UTxO ${outpointOf(row)}: ${(error as Error).message}`);
      }
    });
  }

  return {
    name: 'koios',

    async networkId() {
      const method = 'queryNetwork/genesisConfiguration';
      const answer = await ogmiosCall(forwarded, method, { era: 'shelley' });
      if ('error' in answer) throw unavailable(method, `error ${answer.error.code}: ${answer.error.message}`);
      const result = record(answer.result);
      const network = result?.['network'];
      if (network !== 'mainnet' && network !== 'testnet') throw unavailable(method, `unexpected answer: network must be mainnet or testnet, got ${String(network)}`);
      // mainnet or testnet alone would let a preview URL pass under network preprod.
      const magic = result?.['networkMagic'];
      const expected = NETWORK_MAGIC[opts.network];
      if (magic !== expected) {
        const served = Object.entries(NETWORK_MAGIC).find(([, m]) => m === magic)?.[0] ?? 'an unknown network';
        throw unavailable(method, `the url serves network magic ${String(magic)} (${served}), ledger.chain.network ${opts.network} has network magic ${expected}`);
      }
      return network === 'mainnet' ? 1 : 0;
    },

    async utxosAt(address) {
      const query = { _addresses: [toBech32(address)], _extended: true };
      // One page is one query and one state of the chain, the common case costs a single request.
      const first = await request('address_utxos', query, `?order=tx_hash.asc,tx_index.asc&offset=0&limit=${PAGE}`);
      if (first.length < PAGE) return utxos('address_utxos', first);
      // Offsets shift when the chain moves between two pages, an output can be skipped or come twice.
      // So the whole listing counts only with the same tip before and after it.
      for (let attempt = 0; attempt < LISTING_ATTEMPTS; attempt++) {
        const before = await tip();
        const rows = await listing(query);
        if ((await tip()) === before) return utxos('address_utxos', rows);
      }
      throw unavailable('address_utxos', 'address listing kept changing');
    },

    async unspentOutputs(inputs) {
      const refs = [...new Set(inputs.map(refOf))];
      const out: Utxo[] = [];
      for (let i = 0; i < refs.length; i += REFS_PER_REQUEST) {
        const rows = await request('utxo_info', { _utxo_refs: refs.slice(i, i + REFS_PER_REQUEST), _extended: true });
        out.push(...utxos('utxo_info', rows));
      }
      return out;
    },

    async stakeRegistered(stakeKeyHash) {
      const rows = await request('account_info', { _stake_addresses: [toBech32(rewardAddressBytes(networkId, stakeKeyHash))] });
      return rows.some((row) => record(row)?.['status'] === 'registered');
    },

    // The Ogmios provider's submit: a refusal comes back as it came, a JSON-RPC code below 0 is a transport failure.
    submit: (tx) => ogmios.submit(tx),
  };
}
