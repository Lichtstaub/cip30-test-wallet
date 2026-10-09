// Drives the wallet against a devnet without a browser: the page side runs in Node through pageWith,
// behind the binding sits a ChainLedger over Ogmios. Fees and cost models come from the devnet.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bytesToHex, concat, hexToBytes } from '../../src/core/bytes.js';
import { decode, decodeItem, readHeader, Tagged, type CborValue } from '../../src/core/cbor/decode.js';
import { encode } from '../../src/core/cbor/encode.js';
import type { TxInput } from '../../src/core/cbor/tx.js';
import { parseAddressArg } from '../../src/core/sign-data.js';
import type { ChainLedger } from '../../src/host/chain/chain-ledger.js';
import { ogmiosCall, ogmiosProvider } from '../../src/host/chain/ogmios.js';
import type { ChainProvider } from '../../src/host/chain/provider.js';
import { prepareWallet, type PreparedWallet } from '../../src/host/config.js';
import type { CostModels } from '../../src/host/cost-models.js';
import { chainLedger, LEDGER_BINDING } from '../../src/host/ledger.js';
import { installWallet, type InstallTarget } from '../../src/page/install.js';
import type { Cip30Api, Cip95Api } from '../../src/page/provider.js';
import { chwProvider, enableChw, pageWith, type TestApi } from '../../test/helpers/page.js';

export interface ChainWallet {
  prepared: PreparedWallet;
  /** The raw provider, for looking at the chain past the wallet. */
  provider: ChainProvider;
  ledger: ChainLedger;
  page: InstallTarget & Record<string, unknown>;
  api: TestApi;
  /** The base address of the account. */
  address: Uint8Array;
  stakeKeyHash: Uint8Array;
}

/** The wallet of this account of the default mnemonic, in chain mode against the Ogmios at ogmiosUrl, enabled. */
export async function chainWallet(ogmiosUrl: string, accountIndex: number): Promise<ChainWallet> {
  const prepared = prepareWallet({ accountIndex, ledger: { chain: { provider: 'ogmios', url: ogmiosUrl } } });
  const provider = ogmiosProvider({ url: ogmiosUrl });
  const ledger = chainLedger(prepared, provider);
  const page = pageWith(ledger);
  installWallet({ ...prepared.config, ledger: { ...prepared.config.ledger!, binding: LEDGER_BINDING } }, page);
  return {
    prepared,
    provider,
    ledger,
    page,
    api: await enableChw(page),
    address: parseAddressArg(prepared.addresses.payment),
    stakeKeyHash: parseAddressArg(prepared.addresses.reward).slice(1),
  };
}

/** The CIP-95 namespace of the same wallet. */
export async function cip95Of(w: ChainWallet): Promise<Cip95Api> {
  const api = (await chwProvider(w.page).enable({ extensions: [{ cip: 95 }] })) as Cip30Api;
  return api.cip95!;
}

export interface DevnetParams {
  minFeeA: bigint;
  minFeeB: bigint;
  keyDeposit: bigint;
  priceMem: [bigint, bigint];
  priceSteps: [bigint, bigint];
  costModels: CostModels;
  protocolMajor: bigint;
}

interface OgmiosParams {
  minFeeCoefficient: number | string;
  minFeeConstant: { ada: { lovelace: number | string } };
  stakeCredentialDeposit: { ada: { lovelace: number | string } };
  scriptExecutionPrices: { memory: string; cpu: string };
  plutusCostModels: Record<string, Array<number | string>>;
  version: { major: number | string };
}

/** The protocol parameters the tests build with, read from the devnet. Its cost models differ from mainnet and preprod. */
export async function devnetParams(ogmiosUrl: string): Promise<DevnetParams> {
  const answer = await ogmiosCall({ url: ogmiosUrl }, 'queryLedgerState/protocolParameters');
  if (!('result' in answer)) throw new Error(`protocolParameters: ${answer.error.code} ${answer.error.message}`);
  const r = answer.result as OgmiosParams;
  const ratio = (fraction: string): [bigint, bigint] => {
    const [numerator, denominator] = fraction.split('/');
    return [BigInt(numerator!), BigInt(denominator!)];
  };
  // Node 11 has no PlutusV2 cost model on a devnet, an empty list stands for it.
  const model = (language: string) => (r.plutusCostModels[language] ?? []).map((v) => BigInt(v));
  return {
    minFeeA: BigInt(r.minFeeCoefficient),
    minFeeB: BigInt(r.minFeeConstant.ada.lovelace),
    keyDeposit: BigInt(r.stakeCredentialDeposit.ada.lovelace),
    priceMem: ratio(r.scriptExecutionPrices.memory),
    priceSteps: ratio(r.scriptExecutionPrices.cpu),
    costModels: { PlutusV1: model('plutus:v1'), PlutusV2: model('plutus:v2'), PlutusV3: model('plutus:v3') },
    protocolMajor: BigInt(r.version.major),
  };
}

/** Bytes one vkey witness adds: [vkey, signature] takes 101, the rest covers the headers of the witness set. */
export const VKEY_WITNESS_BYTES = 110;

/** The minimum fee for a transaction of this size and these ExUnits, rounded up per price. */
export function minFee(p: DevnetParams, size: number, exUnits?: { mem: bigint; steps: bigint }): bigint {
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const scripts = exUnits ? ceil(exUnits.mem * p.priceMem[0], p.priceMem[1]) + ceil(exUnits.steps * p.priceSteps[0], p.priceSteps[1]) : 0n;
  return p.minFeeA * BigInt(size) + p.minFeeB + scripts;
}

/**
 * Builds with a fee that covers the transaction once it carries vkeys witnesses. The fee moves
 * the size by a few bytes at most, so it settles within a few rounds.
 */
export function settleFee(p: DevnetParams, vkeys: number, build: (fee: bigint) => string, exUnits?: { mem: bigint; steps: bigint }): { tx: string; fee: bigint } {
  let fee = 0n;
  for (let round = 0; round < 5; round++) {
    const tx = build(fee);
    const needed = minFee(p, tx.length / 2 + VKEY_WITNESS_BYTES * vkeys, exUnits);
    if (needed <= fee) return { tx, fee };
    fee = needed;
  }
  throw new Error('the fee did not settle within five rounds');
}

const asList = (value: CborValue | undefined): CborValue[] =>
  value === undefined ? [] : value instanceof Tagged ? (value.value as CborValue[]) : (value as CborValue[]);

/**
 * The transaction with the wallet's vkey witnesses added to its own witness set. The body bytes
 * stay as they are, and every other witness set entry keeps its bytes, so the script data hash holds.
 */
export function addWalletWitnesses(txHex: string, walletWitnessSetHex: string): string {
  const tx = hexToBytes(txHex);
  const bodyStart = readHeader(tx, 0).next;
  const bodyEnd = decodeItem(tx, bodyStart).next;
  const witnessEnd = decodeItem(tx, bodyEnd).next;
  const ownBytes = tx.slice(bodyEnd, witnessEnd);
  const own = decode(ownBytes) as Map<CborValue, CborValue>;
  if (bytesToHex(encode(own as never)) !== bytesToHex(ownBytes)) throw new Error('the witness set of the transaction does not re-encode byte for byte');
  const wallet = decode(hexToBytes(walletWitnessSetHex)) as Map<CborValue, CborValue>;
  const merged = new Map<CborValue, CborValue>([[0n, [...asList(own.get(0n)), ...asList(wallet.get(0n))]]]);
  for (const [key, value] of own) if (key !== 0n) merged.set(key, value);
  return bytesToHex(concat(tx.slice(0, bodyEnd), encode(merged as never), tx.slice(witnessEnd)));
}

/** Signs through the page wallet at partialSign false, adds the witnesses and submits through the page wallet. */
export async function signAndSubmit(w: ChainWallet, unsignedHex: string): Promise<{ signed: string; id: string }> {
  const signed = addWalletWitnesses(unsignedHex, await w.api.signTx(unsignedHex, false));
  return { signed, id: await w.api.submitTx(signed) };
}

/** 'txid#index'. */
export function outpoint(input: TxInput): string {
  return `${bytesToHex(input.txId)}#${input.index}`;
}

/** The outpoints the page wallet's getUtxos() returns, in its order. */
export async function walletOutpoints(w: ChainWallet): Promise<string[]> {
  return ((await w.api.getUtxos()) ?? []).map((hex) => {
    const input = CSL.TransactionUnspentOutput.from_hex(hex).input();
    return `${input.transaction_id().to_hex()}#${input.index()}`;
  });
}

/** The lovelace of a CIP-30 getBalance() value. */
export function coinOfBalance(valueHex: string): bigint {
  return BigInt(CSL.Value.from_hex(valueHex).coin().to_str());
}

/** Polls every 50 ms until check holds. */
export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The slot of the chain tip at Ogmios. */
export async function tipSlot(ogmiosUrl: string): Promise<number> {
  const answer = await ogmiosCall({ url: ogmiosUrl }, 'queryNetwork/tip');
  const slot = 'result' in answer ? (answer.result as { slot?: unknown } | null)?.slot : undefined;
  if (typeof slot !== 'number') throw new Error(`queryNetwork/tip answered without a slot: ${JSON.stringify(answer)}`);
  return slot;
}

/** Until the node adopted the next block. A transaction submitted right after has about one slot, 1 s, before the block after it. */
export async function nextBlock(ogmiosUrl: string): Promise<void> {
  const start = await tipSlot(ogmiosUrl);
  await waitFor(async () => (await tipSlot(ogmiosUrl)) > start, 'the devnet forged the next block', 10_000);
}

/** Until every transaction the wallet submitted has left its pending overlay, by its block or by a spent input. */
export function waitSettled(w: ChainWallet): Promise<void> {
  return waitFor(async () => (await w.ledger.pendingTxIds()).length === 0, 'the chain shows every pending transaction');
}
