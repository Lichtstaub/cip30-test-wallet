import { describe, expect, it } from 'vitest';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { baseAddressBytes, rewardAddressBytes } from '../src/core/addresses.js';
import { ChwError, TxSignErrorCode } from '../src/core/errors.js';
import { keyHash, publicKey, sign, type SigningKey } from '../src/core/keys.js';
import { MemoryLedger, type Utxo } from '../src/core/ledger.js';
import { scriptHash } from '../src/core/scripts.js';
import { parseTxHex, signTx as signParsed, type SignContext } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { buildTx, witnessVkeys } from './helpers/build-tx.js';
import { syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const other = deriveAccount(MNEMONIC, 1);
const third = deriveAccount(MNEMONIC, 2);
const hashOf = (key: SigningKey) => keyHash(publicKey(key));
const pub = (key: SigningKey) => bytesToHex(publicKey(key));
const myPay = hashOf(me.payment);
const myStake = hashOf(me.stake);
const myDrep = hashOf(me.drep);

type Native = unknown[];
const pubkey = (hash: Uint8Array): Native => [0n, hash];
const all = (...scripts: Native[]): Native => [1n, scripts];
const any = (...scripts: Native[]): Native => [2n, scripts];
const nOfK = (n: bigint, ...scripts: Native[]): Native => [3n, n, scripts];
const before = (slot: bigint): Native => [4n, slot];
const hereafter = (slot: bigint): Native => [5n, slot];
const nativeHash = (script: Native) => scriptHash(0, encode(script as never));
// A Plutus V3 script as the witness set carries it. Never executed.
const PLUTUS = hexToBytes('4601000022499d');
const plutusHash = scriptHash(3, PLUTUS);
/** Testnet enterprise address with a script payment credential (header type 7). */
const scriptAddress = (hash: Uint8Array) => concat(Uint8Array.of(0x70), hash);
/** Testnet reward address with a script credential (header type 15). */
const scriptReward = (hash: Uint8Array) => concat(Uint8Array.of(0xf0), hash);
const anchor = ['https://example.com/a.json', new Uint8Array(32)];
const govActionId = [new Uint8Array(32).fill(3), 0n];

const mine: Utxo = { input: syntheticInput('scripts-mine', 0n), address: baseAddressBytes(0, myPay, myStake), lovelace: 10_000_000n };
const theirs: Utxo = { input: syntheticInput('scripts-theirs', 0n), address: baseAddressBytes(0, hashOf(other.payment), myStake), lovelace: 5_000_000n };
const locked = (hash: Uint8Array, seed = 'scripts-locked'): Utxo => ({ input: syntheticInput(seed, 0n), address: scriptAddress(hash), lovelace: 5_000_000n });
const holding = (seed: string, scriptRef: Uint8Array): Utxo => ({ input: syntheticInput(seed, 0n), address: theirs.address, lovelace: 20_000_000n, scriptRef });
const outpoints = (...utxos: Utxo[]) => new Tagged(258n, utxos.map((u) => [u.input.txId, u.input.index]));

const ctx = (foreign: Utxo[] = [], drep = true): SignContext => ({
  payment: me.payment,
  stake: me.stake,
  ...(drep ? { drep: me.drep } : {}),
  ledger: new MemoryLedger({ owned: [mine], foreign }),
});
const signTxHex = (txHex: string, partial: boolean, context: SignContext) => signParsed(parseTxHex(txHex).parsed, partial, context);

interface ScriptTx {
  inputs?: Utxo[];
  body?: Array<[bigint, unknown]>;
  natives?: Native[];
  plutus?: Uint8Array[];
  vkeys?: Array<[Uint8Array, Uint8Array]>;
}
function scriptTx(opts: ScriptTx): string {
  const witnessSet = new Map<bigint, unknown>();
  if (opts.vkeys?.length) witnessSet.set(0n, opts.vkeys);
  if (opts.natives?.length) witnessSet.set(1n, opts.natives);
  if (opts.plutus?.length) witnessSet.set(7n, opts.plutus);
  return buildTx({ inputs: (opts.inputs ?? [mine]).map((u) => u.input), outputs: [], fee: 200_000n, extraBodyEntries: new Map(opts.body ?? []), witnessSet });
}
/** The same transaction with a valid witness of a co-signer, the way the co-signer hands it on. The body and so its hash stay the same. */
function coSigned(opts: ScriptTx, key: SigningKey): string {
  const { hash } = parseTransaction(hexToBytes(scriptTx(opts)));
  return scriptTx({ ...opts, vkeys: [[publicKey(key), sign(key, hash)]] });
}
/** 'signed', a ChwError code or a CIP-30 code, so one line states the outcome. */
async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return 'signed';
  } catch (e) {
    return e instanceof ChwError ? e.code : (e as { code: number }).code;
  }
}

describe('native scripts', () => {
  it('an input at a native script address with the wallet payment key is signed with that key', async () => {
    const script = all(pubkey(myPay));
    const u = locked(nativeHash(script));
    expect(witnessVkeys(await signTxHex(scriptTx({ inputs: [mine, u], natives: [script] }), false, ctx([u])))).toEqual([pub(me.payment)]);
  });

  it('a stake key in the script adds the stake witness', async () => {
    const script = all(pubkey(myStake));
    const u = locked(nativeHash(script));
    expect(witnessVkeys(await signTxHex(scriptTx({ inputs: [mine, u], natives: [script] }), false, ctx([u])))).toEqual([pub(me.payment), pub(me.stake)]);
  });

  it('2 of 3 with a co-signer: ProofGeneration alone, signed once the co-signer witnessed, own share at partialSign true', async () => {
    const script = nOfK(2n, pubkey(myPay), pubkey(hashOf(other.payment)), pubkey(hashOf(third.payment)));
    const u = locked(nativeHash(script));
    const opts: ScriptTx = { inputs: [mine, u], natives: [script] };
    await expect(signTxHex(scriptTx(opts), false, ctx([u]))).rejects.toEqual(
      expect.objectContaining({ code: TxSignErrorCode.ProofGeneration, info: expect.stringMatching(/native script/) }),
    );
    expect(witnessVkeys(await signTxHex(coSigned(opts, other.payment), false, ctx([u])))).toEqual([pub(me.payment)]);
    expect(witnessVkeys(await signTxHex(scriptTx(opts), true, ctx([u])))).toEqual([pub(me.payment)]);
  });

  it('any with two different satisfying sets: the wallet keys alone, or a co-signer', async () => {
    const script = any(all(pubkey(myPay), pubkey(myStake)), pubkey(hashOf(other.payment)));
    const u = locked(nativeHash(script));
    const opts: ScriptTx = { inputs: [mine, u], natives: [script] };
    expect(witnessVkeys(await signTxHex(scriptTx(opts), false, ctx([u])))).toEqual([pub(me.payment), pub(me.stake)]);
    expect(witnessVkeys(await signTxHex(coSigned(opts, other.payment), false, ctx([u])))).toEqual([pub(me.payment), pub(me.stake)]);
  });

  it('any of two foreign keys: ProofGeneration without either, signed with the second one', async () => {
    const script = any(pubkey(hashOf(other.payment)), pubkey(hashOf(third.payment)));
    const u = locked(nativeHash(script));
    const opts: ScriptTx = { inputs: [mine, u], natives: [script] };
    expect(await outcome(signTxHex(scriptTx(opts), false, ctx([u])))).toBe(TxSignErrorCode.ProofGeneration);
    expect(witnessVkeys(await signTxHex(coSigned(opts, third.payment), false, ctx([u])))).toEqual([pub(me.payment)]);
  });

  it('timelocks read validity start (8) and ttl (3), on the boundary and without the field', async () => {
    const script = all(pubkey(myPay), before(100n), hereafter(200n));
    const u = locked(nativeHash(script));
    const tx = (body: Array<[bigint, unknown]>) => scriptTx({ inputs: [mine, u], natives: [script], body });
    expect(await outcome(signTxHex(tx([[8n, 100n], [3n, 200n]]), false, ctx([u])))).toBe('signed');
    expect(await outcome(signTxHex(tx([[8n, 99n], [3n, 200n]]), false, ctx([u])))).toBe(TxSignErrorCode.ProofGeneration);
    expect(await outcome(signTxHex(tx([[8n, 100n], [3n, 201n]]), false, ctx([u])))).toBe(TxSignErrorCode.ProofGeneration);
    expect(await outcome(signTxHex(tx([[3n, 200n]]), false, ctx([u])))).toBe(TxSignErrorCode.ProofGeneration);
    expect(await outcome(signTxHex(tx([[8n, 100n]]), false, ctx([u])))).toBe(TxSignErrorCode.ProofGeneration);
    expect(witnessVkeys(await signTxHex(tx([]), true, ctx([u])))).toEqual([pub(me.payment)]);
  });

  it('a DRep key in a native script is foreign for a wallet without CIP-95', async () => {
    const script = all(pubkey(myDrep));
    const votes = new Map([[[3n, nativeHash(script)], new Map([[govActionId, [1n, null]]])]]);
    const tx = scriptTx({ body: [[19n, votes]], natives: [script] });
    expect(witnessVkeys(await signTxHex(tx, false, ctx()))).toEqual([pub(me.payment), pub(me.drep)]);
    expect(await outcome(signTxHex(tx, false, ctx([], false)))).toBe(TxSignErrorCode.ProofGeneration);
    expect(witnessVkeys(await signTxHex(tx, true, ctx([], false)))).toEqual([pub(me.payment)]);
  });

  it('a native mint policy with the stake key, a Plutus mint policy without a witness', async () => {
    const policy = all(pubkey(myStake));
    const mint = (p: Uint8Array) => new Map([[p, new Map([[new Uint8Array(0), 1n]])]]);
    expect(witnessVkeys(await signTxHex(scriptTx({ body: [[9n, mint(nativeHash(policy))]], natives: [policy] }), false, ctx()))).toEqual([pub(me.payment), pub(me.stake)]);
    expect(witnessVkeys(await signTxHex(scriptTx({ body: [[9n, mint(plutusHash)]], plutus: [PLUTUS] }), false, ctx()))).toEqual([pub(me.payment)]);
  });

  it('the same script needed twice resolves once and signs each role once', async () => {
    const script = all(pubkey(myStake));
    const hash = nativeHash(script);
    const u = locked(hash);
    const tx = scriptTx({ inputs: [mine, u], natives: [script], body: [[9n, new Map([[hash, new Map([[new Uint8Array(0), 1n]])]])]] });
    expect(witnessVkeys(await signTxHex(tx, false, ctx([u])))).toEqual([pub(me.payment), pub(me.stake)]);
  });

  it('a committee script credential gets no wallet role even when its native script names a wallet key', async () => {
    const script = all(pubkey(myStake));
    const tx = scriptTx({ body: [[4n, [[14n, [1n, nativeHash(script)], [0n, new Uint8Array(28).fill(8)]]]]], natives: [script] });
    expect(await outcome(signTxHex(tx, false, ctx()))).toBe(TxSignErrorCode.ProofGeneration);
    expect(witnessVkeys(await signTxHex(tx, true, ctx()))).toEqual([pub(me.payment)]);
  });

  it('script credentials in a withdrawal and a certificate are resolved like script inputs', async () => {
    const script = all(pubkey(myStake));
    const hash = nativeHash(script);
    const withdrawal = scriptTx({ body: [[5n, new Map([[scriptReward(hash), 0n]])]], natives: [script] });
    expect(witnessVkeys(await signTxHex(withdrawal, false, ctx()))).toEqual([pub(me.payment), pub(me.stake)]);
    const certificate = scriptTx({ body: [[4n, [[9n, [1n, hash], [0n, myDrep]]]]], natives: [script] });
    expect(witnessVkeys(await signTxHex(certificate, false, ctx()))).toEqual([pub(me.payment), pub(me.stake)]);
  });
});

describe('Plutus scripts', () => {
  it('a Plutus spend with own collateral: the payment key for the collateral, no witness for the script', async () => {
    const u = locked(plutusHash);
    const tx = scriptTx({ inputs: [u], plutus: [PLUTUS], body: [[13n, outpoints(mine)], [11n, new Uint8Array(32)]] });
    expect(witnessVkeys(await signTxHex(tx, false, ctx([u])))).toEqual([pub(me.payment)]);
  });

  it('a guardrail script in a proposal is resolved from the witness set', async () => {
    const reward = rewardAddressBytes(0, myStake);
    const guarded = [100n, reward, [2n, new Map([[reward, 5n]]), plutusHash], anchor];
    expect(witnessVkeys(await signTxHex(scriptTx({ body: [[20n, [guarded]]], plutus: [PLUTUS] }), false, ctx()))).toEqual([pub(me.payment)]);
    expect(await outcome(signTxHex(scriptTx({ body: [[20n, [guarded]]] }), false, ctx()))).toBe('CHW_UNRESOLVED_SCRIPT');
  });
});

describe('reference scripts and reference inputs', () => {
  it('a script from the scriptRef of a reference input or of a spent input resolves the requirement', async () => {
    const u = locked(plutusHash);
    const holder = holding('ref-holder', encode([3n, PLUTUS]));
    expect(witnessVkeys(await signTxHex(scriptTx({ inputs: [mine, u], body: [[18n, outpoints(holder)]] }), false, ctx([u, holder])))).toEqual([pub(me.payment)]);
    const spentHolder: Utxo = { ...mine, input: syntheticInput('scripts-mine-ref', 0n), scriptRef: encode([3n, PLUTUS]) };
    expect(witnessVkeys(await signTxHex(scriptTx({ inputs: [spentHolder, u] }), false, ctx([u, spentHolder])))).toEqual([pub(me.payment)]);
  });

  it('a native script from a reference script is hashed over its bytes there and contributes its wallet key', async () => {
    const script = all(pubkey(myStake));
    const u = locked(nativeHash(script));
    const holder = holding('ref-native', encode([0n, script] as never));
    expect(witnessVkeys(await signTxHex(scriptTx({ inputs: [mine, u], body: [[18n, outpoints(holder)]] }), false, ctx([u, holder])))).toEqual([pub(me.payment), pub(me.stake)]);
  });

  it('a reference input the ledger does not know is CHW_UNRESOLVED_INPUT at both partialSign values', async () => {
    const tx = scriptTx({ body: [[18n, outpoints(holding('ref-unknown', encode([3n, PLUTUS])))]] });
    for (const partial of [false, true]) {
      await expect(signTxHex(tx, partial, ctx())).rejects.toThrow(/CHW_UNRESOLVED_INPUT: reference input [0-9a-f]{64}#0/);
    }
  });

  it('a scriptRef on a collateral input is no source: CHW_UNRESOLVED_SCRIPT', async () => {
    const u = locked(plutusHash);
    const collateralHolder: Utxo = { input: syntheticInput('collateral-holder', 0n), address: mine.address, lovelace: 5_000_000n, scriptRef: encode([3n, PLUTUS]) };
    const tx = scriptTx({ inputs: [mine, u], body: [[13n, outpoints(collateralHolder)]] });
    expect(await outcome(signTxHex(tx, false, ctx([u, collateralHolder])))).toBe('CHW_UNRESOLVED_SCRIPT');
  });

  it('a scriptRef that does not parse provides no script, and the diagnosis names the UTxO carrying it', async () => {
    const u = locked(plutusHash);
    const holder = holding('bad-ref', encode([9n, PLUTUS]));
    const tx = scriptTx({ inputs: [mine, u], body: [[18n, outpoints(holder)]] });
    await expect(signTxHex(tx, true, ctx([u, holder]))).rejects.toThrow(
      new RegExp(`CHW_UNRESOLVED_SCRIPT: .*the scriptRef of reference input ${bytesToHex(holder.input.txId)}#0 could not be read`),
    );
  });
});

describe('error order', () => {
  it('a missing script is CHW_UNRESOLVED_SCRIPT at both partialSign values and names the hash and both fixes', async () => {
    const hash = nativeHash(all(pubkey(myPay)));
    const u = locked(hash);
    for (const partial of [false, true]) {
      let caught: unknown;
      try {
        await signTxHex(scriptTx({ inputs: [mine, u] }), partial, ctx([u]));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ChwError);
      expect((caught as ChwError).code).toBe('CHW_UNRESOLVED_SCRIPT');
      expect((caught as ChwError).message).toContain(bytesToHex(hash));
      expect((caught as ChwError).message).toMatch(/witness set/);
      expect((caught as ChwError).message).toMatch(/scriptRef/);
    }
  });

  it('CHW_UNRESOLVED_SCRIPT comes before ProofGeneration for an uncovered foreign input', async () => {
    const u = locked(nativeHash(all(pubkey(myPay))));
    expect(await outcome(signTxHex(scriptTx({ inputs: [mine, theirs, u] }), false, ctx([u, theirs])))).toBe('CHW_UNRESOLVED_SCRIPT');
  });

  it('CHW_UNRESOLVED_INPUT comes before CHW_UNRESOLVED_SCRIPT', async () => {
    const u = locked(nativeHash(all(pubkey(myPay))));
    const tx = scriptTx({ inputs: [mine, u], body: [[18n, outpoints(holding('ref-missing', encode([3n, PLUTUS])))]] });
    expect(await outcome(signTxHex(tx, false, ctx([u])))).toBe('CHW_UNRESOLVED_INPUT');
  });

  it('a collateral input at a script address creates no requirement', async () => {
    const u = locked(plutusHash, 'script-collateral');
    expect(witnessVkeys(await signTxHex(scriptTx({ body: [[13n, outpoints(u)]] }), false, ctx([u])))).toEqual([pub(me.payment)]);
  });
});
