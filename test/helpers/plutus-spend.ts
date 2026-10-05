// Plutus spends built with the repo's own encoder, so every byte the script
// integrity hash covers is known: the redeemers as encode() writes them, the
// witness datums likewise, and the language views of the default cost models.
import { blake2b } from '@noble/hashes/blake2.js';
import { baseAddressBytes } from '../../src/core/addresses.js';
import { bytesToHex, concat, hexToBytes } from '../../src/core/bytes.js';
import { Tagged, type CborValue } from '../../src/core/cbor/decode.js';
import { encode } from '../../src/core/cbor/encode.js';
import { parseTransaction } from '../../src/core/cbor/tx.js';
import { keyHash, publicKey, sign, type SigningKey } from '../../src/core/keys.js';
import { encodeOutput, type Datum, type Utxo } from '../../src/core/ledger.js';
import { deriveAccount, type DerivedAccount } from '../../src/derive/index.js';
import { DEFAULT_COST_MODELS } from '../../src/host/cost-models.js';
import { languageViews } from '../../src/host/checks/script-integrity.js';
import { buildTx, type BuildTxOptions } from './build-tx.js';
import type { PlutusFixture } from './plutus-fixtures.js';
import { scriptAddress, syntheticInput } from './synthetic.js';
import { MNEMONIC } from '../fixtures/vectors.js';

/** Constr 0 [], the unit-like redeemer and datum most tests pass. */
export const UNIT_DATA = new Tagged(121n, []);

/** The account of the test mnemonic, its testnet base address and a 50 ADA UTxO there that pays the fee and is the collateral. */
export function myWallet(seed: string): { me: DerivedAccount; myAddress: Uint8Array; wallet: Utxo } {
  const me = deriveAccount(MNEMONIC);
  const myAddress = baseAddressBytes(0, keyHash(publicKey(me.payment)), keyHash(publicKey(me.stake)));
  return { me, myAddress, wallet: { input: syntheticInput(seed, 0n), address: myAddress, lovelace: 50_000_000n } };
}

/** A 5 ADA output at the testnet script address of this fixture, with an optional datum. */
export function lockedUtxo(script: Pick<PlutusFixture, 'hash'>, seed: string, datum?: Datum, lovelace = 5_000_000n): Utxo {
  return { input: syntheticInput(seed, 0n), address: scriptAddress(script.hash), lovelace, ...(datum ? { datum } : {}) };
}

/** walletOptions.foreignUtxos entry for a UTxO without datum or reference script. */
export const foreignConfig = (u: Utxo) => ({ txId: bytesToHex(u.input.txId), index: Number(u.input.index), addressHex: bytesToHex(u.address), lovelace: Number(u.lovelace) });

/** An inline datum holding this plutus_data. */
export const inlineDatum = (data: CborValue): Datum => ({ kind: 'inline', cbor: encode(data) });

export interface ScriptSpend {
  utxo: Utxo;
  script: PlutusFixture;
  redeemer?: CborValue;
  /** Declared ExUnits, 100000 mem and 10000000 steps when left out. */
  exUnits?: { mem: bigint; steps: bigint };
}

function compareInputs(a: Utxo, b: Utxo): number {
  const x = bytesToHex(a.input.txId);
  const y = bytesToHex(b.input.txId);
  return x < y ? -1 : x > y ? 1 : Number(a.input.index - b.input.index);
}

// Witness set keys of Plutus V1, V2 and V3 scripts.
const WITNESS_KEYS = { 1: 3n, 2: 6n, 3: 7n } as const;

/**
 * The witness set entries of these script spends (scripts, datums, redeemers)
 * and the script data hash for body key 11. inputs are all spend inputs of the
 * transaction: a spend redeemer points at its position in their sorted set
 * (Conway UTxO.hs getConwayScriptsNeeded). The hash is Alonzo Tx.hs
 * hashScriptIntegrity over these bytes, undefined without any spend.
 */
export function scriptWitnesses(spends: ScriptSpend[], inputs: Utxo[], witnessDatums?: CborValue[]): { witnessSet: Map<bigint, unknown>; scriptDataHash: Uint8Array | undefined } {
  const witnessSet = new Map<bigint, unknown>();
  if (spends.length === 0) return { witnessSet, scriptDataHash: undefined };
  const sorted = [...inputs].sort(compareInputs);
  const redeemers = spends.map((s) => {
    const { mem, steps } = s.exUnits ?? { mem: 100_000n, steps: 10_000_000n };
    return [0n, BigInt(sorted.indexOf(s.utxo)), s.redeemer ?? UNIT_DATA, [mem, steps]];
  });
  for (const { script } of spends) {
    const key = WITNESS_KEYS[script.language];
    const scripts = (witnessSet.get(key) as Uint8Array[] | undefined) ?? [];
    if (!scripts.some((b) => bytesToHex(b) === bytesToHex(script.bytes))) scripts.push(script.bytes);
    witnessSet.set(key, scripts);
  }
  if (witnessDatums) witnessSet.set(4n, witnessDatums);
  witnessSet.set(5n, redeemers);
  const languages = new Set(spends.map((s) => s.script.language));
  const datums = witnessDatums ? encode(witnessDatums as never) : new Uint8Array();
  return { witnessSet, scriptDataHash: blake2b(concat(encode(redeemers as never), datums, languageViews(languages, DEFAULT_COST_MODELS)), { dkLen: 32 }) };
}

/** buildTx with vkey witnesses of these keys added to its own witness set, so scripts and redeemers stay. The body does not depend on the witness set: built once, its hash signed, built again. */
export function withVKeys(opts: BuildTxOptions, keys: SigningKey[]): string {
  if (keys.length === 0) return buildTx(opts);
  const { hash } = parseTransaction(hexToBytes(buildTx(opts)));
  return buildTx({ ...opts, witnessSet: new Map([[0n, keys.map((k) => [publicKey(k), sign(k, hash)])], ...(opts.witnessSet ?? [])]) });
}

export interface PlutusSpendOptions {
  spends: ScriptSpend[];
  /** A key-locked UTxO of the wallet that pays the fee and is the collateral. */
  wallet: Utxo;
  /** Where the change goes, the wallet's own address in most tests. */
  changeAddress: Uint8Array;
  /** A datum on the change output, an inline one in the Babbage map form. */
  changeDatum?: Datum;
  fee?: bigint;
  isValid?: boolean;
  requiredSigners?: Uint8Array[];
  /** Body key 8, the first slot of the validity interval. */
  validityStart?: bigint;
  /** plutus_data for witness set key 4, the datums of outputs locked by a datum hash. */
  witnessDatums?: CborValue[];
  /** Keys whose vkey witnesses go into the witness set. */
  keys?: SigningKey[];
}

/** A balanced spend of the script outputs plus the wallet UTxO, all value back to changeAddress less the fee, the wallet UTxO also as collateral. */
export function plutusSpend(opts: PlutusSpendOptions): string {
  const fee = opts.fee ?? 400_000n;
  const inputs = [opts.wallet, ...opts.spends.map((s) => s.utxo)];
  const { witnessSet, scriptDataHash } = scriptWitnesses(opts.spends, inputs, opts.witnessDatums);
  const body = new Map<bigint, unknown>([[13n, new Tagged(258n, [[opts.wallet.input.txId, opts.wallet.input.index]])]]);
  if (scriptDataHash) body.set(11n, scriptDataHash);
  if (opts.validityStart !== undefined) body.set(8n, opts.validityStart);
  const total = inputs.reduce((sum, u) => sum + u.lovelace, 0n);
  const change = { address: opts.changeAddress, lovelace: total - fee };
  // encodeOutput writes the output of a UTxO, the input it names plays no part in the bytes.
  if (opts.changeDatum) body.set(1n, [encodeOutput({ input: opts.wallet.input, ...change, datum: opts.changeDatum })]);
  return withVKeys(
    {
      inputs: inputs.map((u) => u.input),
      outputs: [change],
      fee,
      ...(opts.requiredSigners ? { requiredSigners: opts.requiredSigners } : {}),
      extraBodyEntries: body,
      witnessSet,
      isValid: opts.isValid ?? true,
    },
    opts.keys ?? [],
  );
}
