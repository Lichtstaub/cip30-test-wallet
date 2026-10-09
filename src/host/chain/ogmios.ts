import { toBech32 } from '../../core/addresses.js';
import { bytesToHex, concat, hexToBytes, isHex } from '../../core/bytes.js';
import type { CborValue } from '../../core/cbor/decode.js';
import { encode } from '../../core/cbor/encode.js';
import type { TxInput } from '../../core/cbor/tx.js';
import type { ChwError } from '../../core/errors.js';
import type { Utxo } from '../../core/ledger.js';
import { scriptFromRef } from '../../core/scripts.js';
import { addAsset, assetQuantity, MAX_UINT64, type MultiAsset } from '../../core/value.js';
import { addressDecoder, addressFromText, jsonInteger } from './json.js';
import type { ChainProvider, OgmiosError, SubmitResult } from './provider.js';
import { chainUnavailable, fetchText, jsonBody, scrub } from './transport.js';

export { CHAIN_TIMEOUT_MS, chainUnavailable, fetchFailure } from './transport.js';

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

/** chainUnavailable under the connection's provider name, its secrets redacted. */
function failure(conn: OgmiosConnection, method: string, reason: string): ChwError {
  return chainUnavailable(conn.provider ?? 'ogmios', method, reason, conn.secrets ?? []);
}

/** The reason for a JSON-RPC error that leaves no usable answer. */
const rpcError = (error: OgmiosError) => `error ${error.code}: ${error.message}`;

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
  const secrets = opts.secrets ?? [];
  const fail = (reason: string) => failure(opts, method, reason);
  const request = params === undefined ? { jsonrpc: '2.0', method, id: null } : { jsonrpc: '2.0', method, params, id: null };
  const { status, text } = await fetchText(
    opts.fetch ?? fetch,
    opts.url,
    () => ({ method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(request) }),
    fail,
  );
  if (status !== 200 && status !== 400) throw fail(`HTTP ${status}`);
  const body = jsonBody(status, text, fail);
  if (typeof body === 'object' && body !== null) {
    const error = ogmiosError((body as { error?: unknown }).error);
    // A server may echo a header in its error text, so the caller gets the error with the secrets redacted.
    if (error) return { error: secrets.length === 0 ? error : (scrub(error, secrets) as OgmiosError) };
    if (status === 200 && 'result' in body) return { result: (body as { result: unknown }).result };
  }
  throw fail(`HTTP ${status} without result or error`);
}

/** The result of a query. A JSON-RPC error leaves no usable answer and throws CHW_CHAIN_UNAVAILABLE, as every transport failure does. */
export async function ogmiosQuery(conn: OgmiosConnection, method: string, params?: unknown): Promise<unknown> {
  const answer = await ogmiosCall(conn, method, params);
  if ('error' in answer) throw failure(conn, method, rpcError(answer.error));
  return answer.result;
}

/** What read returns, a plain Error it throws becomes CHW_CHAIN_UNAVAILABLE 'unexpected answer: <message>'. */
function shapeOf<T>(conn: OgmiosConnection, method: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw failure(conn, method, `unexpected answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** submitTransaction: a refusal comes back as it came, a JSON-RPC code below 0 is a transport failure. */
export async function ogmiosSubmit(conn: OgmiosConnection, tx: Uint8Array): Promise<SubmitResult> {
  const method = 'submitTransaction';
  const answer = await ogmiosCall(conn, method, { transaction: { cbor: bytesToHex(tx) } });
  if ('error' in answer) {
    // Codes below 0 are JSON-RPC's own (bad request, unknown method, undecodable params): no ledger judged the transaction.
    if (answer.error.code < 0) throw failure(conn, method, rpcError(answer.error));
    return { ok: false, error: answer.error };
  }
  return shapeOf(conn, method, () => {
    const id = (answer.result as { transaction?: { id?: unknown } } | null)?.transaction?.id;
    if (!isHex(id, 32)) throw new Error('result.transaction.id must be 32 bytes of hex');
    return { ok: true, txId: hexToBytes(id) };
  });
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
  return readUtxo(json, addressFromText);
}

/** utxoFromOgmios with the address decoder of the answer the row came in. */
function readUtxo(json: unknown, addressOf: (value: unknown) => Uint8Array): Utxo {
  if (typeof json !== 'object' || json === null) throw new Error('utxo must be an object');
  const { transaction, index, address, value, datum, datumHash, script } = json as Record<string, unknown>;
  const txId = (transaction as { id?: unknown } | undefined)?.id;
  if (!isHex(txId, 32)) throw new Error('utxo transaction.id must be 32 bytes of hex');
  const input: TxInput = { txId: hexToBytes(txId.toLowerCase()), index: jsonInteger(index, 'utxo index') };
  const utxo: Utxo = { input, address: addressOf(address), ...valueFromOgmios(value) };
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
  async function utxos(params: unknown): Promise<Utxo[]> {
    const method = 'queryLedgerState/utxo';
    const result = await ogmiosQuery(opts, method, params);
    return shapeOf(opts, method, () => {
      if (!Array.isArray(result)) throw new Error('result must be a list');
      const addressOf = addressDecoder();
      return result.map((row) => readUtxo(row, addressOf));
    });
  }

  return {
    name: opts.provider ?? 'ogmios',
    async networkId() {
      const method = 'queryNetwork/genesisConfiguration';
      const result = await ogmiosQuery(opts, method, { era: 'shelley' });
      return shapeOf(opts, method, () => {
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
      const result = await ogmiosQuery(opts, method, { keys: [credential] });
      return shapeOf(opts, method, () => {
        // Since v6.13 a list of summaries, before that a map keyed by credential. A key that is not registered is missing from both.
        if (Array.isArray(result)) return result.some((s) => (s as { credential?: unknown } | null)?.credential === credential);
        if (typeof result === 'object' && result !== null) return Object.hasOwn(result, credential);
        throw new Error('result must be a list or a map');
      });
    },
    submit: (tx) => ogmiosSubmit(opts, tx),
  };
}
