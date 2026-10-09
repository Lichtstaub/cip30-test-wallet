import { base58, bech32 } from '@scure/base';
import { toBech32 } from '../../core/addresses.js';
import { bytesToHex, concat, hexToBytes, isHex } from '../../core/bytes.js';
import type { CborValue } from '../../core/cbor/decode.js';
import { encode } from '../../core/cbor/encode.js';
import type { TxInput } from '../../core/cbor/tx.js';
import { ChwError } from '../../core/errors.js';
import type { Utxo } from '../../core/ledger.js';
import { scriptFromRef } from '../../core/scripts.js';
import { addAsset, assetQuantity, MAX_UINT64, type MultiAsset } from '../../core/value.js';
import { jsonInteger, parseJsonBig } from './json.js';
import type { ChainProvider, OgmiosError, SubmitResult } from './provider.js';

// Ogmios JSON-RPC 2.0 over HTTP: POST / with the same body a WebSocket
// client sends (server/src/Ogmios/App/Server/Http.hs, postRootR). Ogmios
// answers 200 with result, 400 when the body has an error key, 500 when the
// node's reply is no JSON. Field shapes after the v6.14 and v7.0 schemas
// (cardano.json, ogmios.json), checked against answers of both versions.

/**
 * Where an Ogmios server listens. provider names the service in messages, 'ogmios' unless Koios
 * forwards the call. secrets are values that never appear in a message or a returned error, a token.
 */
export interface OgmiosConnection {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  provider?: string;
  secrets?: readonly string[];
}

/** How long one request may take before it counts as a transport failure. */
export const CHAIN_TIMEOUT_MS = 30_000;

/** The text with every secret replaced by <redacted>. The one place a secret leaves a message. */
function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('<redacted>')), text);
}

/** Every string of a JSON value redacted, keys included, for a JSON-RPC error that goes back to the caller. */
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), scrub(item, secrets)]));
  return value;
}

/** The ChwError for a provider that did not answer usably: '<provider> <method> failed: <reason>', never a URL or a header, every secret redacted. */
export function chainUnavailable(provider: string, method: string, reason: string, secrets: readonly string[] = []): ChwError {
  return new ChwError('CHW_CHAIN_UNAVAILABLE', redact(`${provider} ${method} failed: ${reason}`, secrets));
}

/** Why a fetch rejected, for chainUnavailable: a timeout, or the error code Node's fetch keeps in cause. Never a message, one can name the host or a header value. */
export function fetchFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `no answer within ${CHAIN_TIMEOUT_MS / 1000} s`;
  // Node's fetch rejects with "fetch failed" and keeps the reason (ECONNREFUSED and the like) in cause.code.
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? `request failed: ${code}` : 'request failed';
}

function ogmiosError(value: unknown): OgmiosError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { code, message, data } = value as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') return undefined;
  return data === undefined ? { code, message } : { code, message, data };
}

/**
 * JSON-RPC over HTTP. Returns result, or { error } for a JSON-RPC error answer (HTTP 400 or 200), its
 * strings with the secrets redacted. Throws CHW_CHAIN_UNAVAILABLE otherwise.
 */
export async function ogmiosCall(opts: OgmiosConnection, method: string, params?: unknown): Promise<{ result: unknown } | { error: OgmiosError }> {
  const provider = opts.provider ?? 'ogmios';
  const secrets = opts.secrets ?? [];
  const fail = (reason: string) => chainUnavailable(provider, method, reason, secrets);
  const request = params === undefined ? { jsonrpc: '2.0', method, id: null } : { jsonrpc: '2.0', method, params, id: null };
  let response: Response;
  let text: string;
  try {
    response = await (opts.fetch ?? fetch)(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw fail(fetchFailure(error));
  }
  if (response.status !== 200 && response.status !== 400) throw fail(`HTTP ${response.status}`);
  let body: unknown;
  try {
    body = parseJsonBig(text);
  } catch {
    throw fail(`HTTP ${response.status} with a body that is not JSON`);
  }
  if (typeof body === 'object' && body !== null) {
    const error = ogmiosError((body as { error?: unknown }).error);
    // A server may echo a header in its error text, so the caller gets the error with the secrets redacted.
    if (error) return { error: secrets.length === 0 ? error : (scrub(error, secrets) as OgmiosError) };
    if (response.status === 200 && 'result' in body) return { result: (body as { result: unknown }).result };
  }
  throw fail(`HTTP ${response.status} without result or error`);
}

// Native script clauses as Ogmios writes them (Allegra.hs encodeTimelock) to
// native_script CBOR: after is RequireTimeStart, invalid_before (4), before
// is RequireTimeExpire, invalid_hereafter (5).
function nativeScriptCbor(json: unknown, depth = 0): CborValue {
  if (depth > 256) throw new Error('native script nested too deep');
  if (typeof json !== 'object' || json === null) throw new Error('native script clause must be an object');
  const clause = json as { clause?: unknown; from?: unknown; atLeast?: unknown; slot?: unknown };
  const list = () => {
    if (!Array.isArray(clause.from)) throw new Error(`native script clause ${String(clause.clause)} needs a list in from`);
    return clause.from.map((item) => nativeScriptCbor(item, depth + 1));
  };
  switch (clause.clause) {
    case 'signature':
      if (!isHex(clause.from, 28)) throw new Error('native script signature needs a 28 byte key hash');
      return [0n, hexToBytes(clause.from.toLowerCase())];
    case 'all':
      return [1n, list()];
    case 'any':
      return [2n, list()];
    case 'some':
      return [3n, jsonInteger(clause.atLeast, 'native script atLeast'), list()];
    case 'after':
      return [4n, jsonInteger(clause.slot, 'native script slot')];
    case 'before':
      return [5n, jsonInteger(clause.slot, 'native script slot')];
    default:
      throw new Error(`native script clause ${String(clause.clause)} is not supported`);
  }
}

const PLUTUS_TAGS = new Map<unknown, bigint>([
  ['plutus:v1', 1n],
  ['plutus:v2', 2n],
  ['plutus:v3', 3n],
]);

/**
 * script = [0, native_script] / [1 to 3, plutus script bytes]. Plutus cbor is the
 * byte string the script is hashed over, as a script reference carries it. A
 * native script keeps the cbor bytes Ogmios sends (Ogmios 7.0.0 sends them by
 * default). Encoding the clauses with definite lengths and shortest heads, byte
 * for byte what CSL writes for the same script, is the fallback for a server
 * that omits the cbor.
 */
function scriptRefFromOgmios(script: unknown): Uint8Array {
  if (typeof script !== 'object' || script === null) throw new Error('script must be an object');
  const { language, cbor, json } = script as { language?: unknown; cbor?: unknown; json?: unknown };
  let ref: Uint8Array;
  if (language === 'native') {
    const native = cbor === undefined ? encode(nativeScriptCbor(json)) : isHex(cbor) ? hexToBytes(cbor) : undefined;
    if (!native) throw new Error('native script cbor must be hex');
    ref = concat(Uint8Array.of(0x82, 0x00), native);
  } else {
    const tag = PLUTUS_TAGS.get(language);
    if (tag === undefined) throw new Error(`script language ${String(language)} is not supported`);
    if (!isHex(cbor) || cbor.length === 0) throw new Error(`${language} script cbor must be hex`);
    ref = encode([tag, hexToBytes(cbor)]);
  }
  // Throws on a script the wallet could not read back, so a broken answer stops here.
  scriptFromRef(ref);
  return ref;
}

function addressFromOgmios(address: unknown): Uint8Array {
  if (typeof address !== 'string' || address.length === 0) throw new Error('address must be a string');
  // Shelley addresses come as bech32, Byron addresses as base58. A base address has
  // 103 characters, so the 90 character limit of BIP-173 is switched off.
  if (address.startsWith('addr')) return bech32.fromWords(bech32.decode(address as `${string}1${string}`, false).words);
  return base58.decode(address);
}

function valueFromOgmios(value: unknown): { lovelace: bigint; assets?: MultiAsset } {
  if (typeof value !== 'object' || value === null) throw new Error('value must be an object');
  const { ada, ...policies } = value as Record<string, unknown>;
  const lovelace = jsonInteger((ada as { lovelace?: unknown } | undefined)?.lovelace, 'value.ada.lovelace');
  if (lovelace < 0n || lovelace > MAX_UINT64) throw new Error('value.ada.lovelace is out of range');
  const assets: MultiAsset = new Map();
  for (const [policy, names] of Object.entries(policies)) {
    if (!isHex(policy, 28)) throw new Error(`value has a policy id that is not 28 bytes of hex: ${policy}`);
    if (typeof names !== 'object' || names === null) throw new Error(`value.${policy} must be an object`);
    for (const [name, raw] of Object.entries(names)) {
      if (!isHex(name) || name.length > 64) throw new Error(`value.${policy} has an asset name that is not hex of at most 32 bytes: ${name}`);
      const quantity = jsonInteger(raw, `value.${policy}.${name}`);
      if (quantity <= 0n || assetQuantity(assets, policy.toLowerCase(), name.toLowerCase()) + quantity > MAX_UINT64) {
        throw new Error(`value.${policy}.${name} must be between 1 and 2^64 - 1`);
      }
      addAsset(assets, policy.toLowerCase(), name.toLowerCase(), quantity);
    }
  }
  return assets.size > 0 ? { lovelace, assets } : { lovelace };
}

/** Ogmios UTxO JSON (v6 and v7) to the wallet's Utxo. Throws a plain Error on any other shape. */
export function utxoFromOgmios(json: unknown): Utxo {
  if (typeof json !== 'object' || json === null) throw new Error('utxo must be an object');
  const { transaction, index, address, value, datum, datumHash, script } = json as Record<string, unknown>;
  const txId = (transaction as { id?: unknown } | undefined)?.id;
  if (!isHex(txId, 32)) throw new Error('utxo transaction.id must be 32 bytes of hex');
  const input: TxInput = { txId: hexToBytes(txId.toLowerCase()), index: jsonInteger(index, 'utxo index') };
  const utxo: Utxo = { input, address: addressFromOgmios(address), ...valueFromOgmios(value) };
  // Ogmios never sends datum and datumHash together (TransactionOutput in cardano.json).
  if (datum !== undefined) {
    if (!isHex(datum) || datum.length === 0) throw new Error('utxo datum must be hex');
    utxo.datum = { kind: 'inline', cbor: hexToBytes(datum) };
  } else if (datumHash !== undefined) {
    if (!isHex(datumHash, 32)) throw new Error('utxo datumHash must be 32 bytes of hex');
    utxo.datum = { kind: 'hash', hash: hexToBytes(datumHash) };
  }
  if (script !== undefined) utxo.scriptRef = scriptRefFromOgmios(script);
  return utxo;
}

/** An Ogmios backed ChainProvider: a node of your own, a devnet, or a hosted Ogmios. */
export function ogmiosProvider(opts: OgmiosConnection): ChainProvider {
  const name = opts.provider ?? 'ogmios';
  const secrets = opts.secrets ?? [];
  const fail = (method: string, reason: string) => chainUnavailable(name, method, reason, secrets);

  // A query that answers with a JSON-RPC error has no usable answer, only submit turns an error into a result.
  async function query(method: string, params?: unknown): Promise<unknown> {
    const answer = await ogmiosCall(opts, method, params);
    if ('error' in answer) throw fail(method, `error ${answer.error.code}: ${answer.error.message}`);
    return answer.result;
  }

  function shapeOf<T>(method: string, read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw fail(method, `unexpected answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function utxos(params: unknown): Promise<Utxo[]> {
    const method = 'queryLedgerState/utxo';
    const result = await query(method, params);
    return shapeOf(method, () => {
      if (!Array.isArray(result)) throw new Error('result must be a list');
      return result.map(utxoFromOgmios);
    });
  }

  return {
    name,
    async networkId() {
      const method = 'queryNetwork/genesisConfiguration';
      const result = await query(method, { era: 'shelley' });
      return shapeOf(method, () => {
        const network = (result as { network?: unknown } | null)?.network;
        if (network === 'mainnet') return 1;
        if (network === 'testnet') return 0;
        throw new Error(`network must be mainnet or testnet, got ${String(network)}`);
      });
    },
    utxosAt(address) {
      return utxos({ addresses: [toBech32(address)] });
    },
    async unspentOutputs(inputs) {
      if (inputs.length === 0) return [];
      return utxos({ outputReferences: inputs.map((i) => ({ transaction: { id: bytesToHex(i.txId) }, index: Number(i.index) })) });
    },
    async stakeRegistered(stakeKeyHash) {
      const method = 'queryLedgerState/rewardAccountSummaries';
      const credential = bytesToHex(stakeKeyHash);
      const result = await query(method, { keys: [credential] });
      return shapeOf(method, () => {
        // Since v6.13 a list of summaries, before that a map keyed by credential. A key that is not registered is missing from both.
        if (Array.isArray(result)) return result.some((s) => (s as { credential?: unknown } | null)?.credential === credential);
        if (typeof result === 'object' && result !== null) return Object.hasOwn(result, credential);
        throw new Error('result must be a list or a map');
      });
    },
    async submit(tx): Promise<SubmitResult> {
      const method = 'submitTransaction';
      const answer = await ogmiosCall(opts, method, { transaction: { cbor: bytesToHex(tx) } });
      if ('error' in answer) {
        // Codes below 0 are JSON-RPC's own (bad request, unknown method, undecodable params): no ledger judged the transaction.
        if (answer.error.code < 0) throw fail(method, `error ${answer.error.code}: ${answer.error.message}`);
        return { ok: false, error: answer.error };
      }
      return shapeOf(method, () => {
        const id = (answer.result as { transaction?: { id?: unknown } } | null)?.transaction?.id;
        if (!isHex(id, 32)) throw new Error('result.transaction.id must be 32 bytes of hex');
        return { ok: true, txId: hexToBytes(id) };
      });
    },
  };
}
