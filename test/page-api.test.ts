import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Transaction, TransactionWitnessSet } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { txHash } from '../src/core/cbor/tx.js';
import { decodeCoseKey, decodeCoseSign1 } from '../src/core/cose.js';
import { APIErrorCode, ChwError } from '../src/core/errors.js';
import { keyHash } from '../src/core/hash.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx, standardUnsignedTx, TEST_ADDRESS } from './helpers/build-tx.js';
import { oracleSignedData } from './helpers/cose-oracle.js';
import { chwProvider, enableChw, testConfig } from './helpers/page.js';

const setup = async (overrides = {}) => {
  const target: InstallTarget = {};
  const control = installWallet(testConfig(overrides), target);
  const api = await enableChw(target);
  return { api, control, target };
};

const valueHex = (lovelace: bigint) => bytesToHex(encode(lovelace));

describe('journal argument trimming', () => {
  it('trims a missing argument so getUtxos() and enable() without argument journal []', async () => {
    const target: InstallTarget = {};
    const control = installWallet(testConfig(), target);
    const provider = chwProvider(target);
    const api = (await provider.enable()) as { getUtxos: () => Promise<unknown> };
    await api.getUtxos();
    expect(control.journal.find((e) => e.method === 'enable')!.args).toEqual([]);
    expect(control.journal.find((e) => e.method === 'getUtxos')!.args).toEqual([]);
  });
});

describe('getUtxos', () => {
  it('returns every owned utxo as TransactionUnspentOutput cbor hex', async () => {
    const { api } = await setup();
    const utxos = await api.getUtxos();
    expect(utxos).toHaveLength(2);
    const first = decode(hexToBytes(utxos![0]!)) as [[Uint8Array, bigint], [Uint8Array, bigint]];
    expect(first[0][0]).toHaveLength(32);
    expect(first[1][1]).toBe(10_000_000n);
  });

  it('returns an empty list for an empty wallet when no amount is asked', async () => {
    const { api } = await setup({ utxos: [] });
    expect(await api.getUtxos()).toEqual([]);
  });

  it('selects utxos in order until the requested lovelace is covered', async () => {
    const { api } = await setup();
    expect(await api.getUtxos(valueHex(5_000_000n))).toHaveLength(1);
    expect(await api.getUtxos(valueHex(12_000_000n))).toHaveLength(2);
  });

  it('returns null when the requested amount cannot be reached', async () => {
    const { api } = await setup();
    expect(await api.getUtxos(valueHex(20_000_000n))).toBeNull();
  });

  it('reads the coin out of a multi-asset value with an empty asset map', async () => {
    const { api } = await setup();
    const multi = bytesToHex(encode([3_000_000n, new Map()] as never));
    expect(await api.getUtxos(multi)).toHaveLength(1);
  });

  it('returns null when the value asks for assets, because the wallet holds none', async () => {
    const { api } = await setup();
    // [3_000_000, { policy(28 x 01) => { "A" => 1 } }], written out so the test does not depend on map encoding
    const withToken = '821a002dc6c0a1581c' + '01'.repeat(28) + 'a1414101';
    expect(await api.getUtxos(withToken)).toBeNull();
  });

  it('rejects a malformed value with InvalidRequest', async () => {
    const { api } = await setup();
    const oneElement = '811a002dc6c0';
    const bytesInsteadOfMap = '821a002dc6c04100';
    const shortPolicy = '821a002dc6c0a14101a1414101';
    for (const bad of [oneElement, bytesInsteadOfMap, shortPolicy]) {
      await expect(api.getUtxos(bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });

  it('paginates and throws { maxSize } past the last page', async () => {
    const { api } = await setup();
    expect(await api.getUtxos(undefined, { page: 0, limit: 1 })).toHaveLength(1);
    expect(await api.getUtxos(undefined, { page: 1, limit: 1 })).toHaveLength(1);
    await expect(api.getUtxos(undefined, { page: 2, limit: 1 })).rejects.toEqual({ maxSize: 2 });
    await expect(api.getUtxos(undefined, { page: -1, limit: 1 })).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('answers a paginate that is not an object with InvalidRequest, never a TypeError', async () => {
    const { api } = await setup();
    const getUtxos = api.getUtxos as unknown as (amount: unknown, paginate: unknown) => Promise<unknown>;
    const getUsed = api.getUsedAddresses as unknown as (paginate: unknown) => Promise<unknown>;
    for (const bad of [null, 1, 'x']) {
      await expect(getUtxos(undefined, bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
      await expect(getUsed(bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });

  it('rejects an amount that is not a cbor value', async () => {
    const { api } = await setup();
    await expect(api.getUtxos('zz')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});

describe('getBalance', () => {
  it('sums the owned lovelace as a cbor uint', async () => {
    const { api } = await setup();
    expect(decode(hexToBytes(await api.getBalance()))).toBe(14_500_000n);
  });
});

describe('getUsedAddresses', () => {
  it('applies paginate to the single used address and throws { maxSize } past the end', async () => {
    const { api } = await setup();
    const [address] = await api.getUsedAddresses();
    expect(await api.getUsedAddresses({ page: 0, limit: 1 })).toEqual([address]);
    await expect(api.getUsedAddresses({ page: 1, limit: 1 })).rejects.toEqual({ maxSize: 1 });
    await expect(api.getUsedAddresses({ page: 0, limit: 0 })).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('paginates an empty wallet to an empty first page', async () => {
    const { api } = await setup({ utxos: [] });
    expect(await api.getUsedAddresses({ page: 0, limit: 5 })).toEqual([]);
  });
});

describe('signTx and submitTx', () => {
  const config = testConfig();

  const unsignedFor = (target: InstallTarget) => {
    // Spend utxo 0 of the installed wallet. The synthetic id is deterministic.
    expect(chwProvider(target)).toBeDefined();
    return standardUnsignedTx(config.name);
  };

  it('signs an owned input and returns only the new witness set', async () => {
    const { api, target } = await setup();
    const ws = await api.signTx(unsignedFor(target), false);
    expect(TransactionWitnessSet.fromCBORHex(ws).toJSON().vkeyWitnesses).toHaveLength(1);
  });

  it('defaults partialSign to false and raises the mock error for an unknown input', async () => {
    const { api } = await setup();
    const unknown = buildTx({ inputs: [{ txId: new Uint8Array(32).fill(9), index: 0n }], outputs: [{ address: TEST_ADDRESS, lovelace: 1n }], fee: 1n });
    await expect(api.signTx(unknown)).rejects.toBeInstanceOf(ChwError);
  });

  it('submitTx records the bytes and returns the transaction id', async () => {
    const { api, target, control } = await setup();
    const unsigned = unsignedFor(target);
    const ws = await api.signTx(unsigned, false);
    const signed = Transaction.addVKeyWitnessesHex(unsigned, ws);
    const id = await api.submitTx(signed);
    expect(id).toBe(bytesToHex(txHash(hexToBytes(signed))));
    const submit = control.journal.find((e) => e.method === 'submitTx');
    expect(submit!.args).toEqual([signed]);
    expect(submit!.result).toBe(id);
  });

  it('rejects non-hex input to signTx and submitTx with InvalidRequest', async () => {
    const { api } = await setup();
    await expect(api.signTx('nope')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    await expect(api.submitTx('nope')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('rejects submitTx input that is not one complete cbor array of four, and journals the failures', async () => {
    const { api, control } = await setup();
    // '' passes the hex check, '00' is a cbor uint, '84a0' announces four items and delivers one
    for (const bad of ['', '00', '84a0']) {
      await expect(api.submitTx(bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
    const failed = control.journal.filter((e) => e.method === 'submitTx');
    expect(failed).toHaveLength(3);
    expect(failed.every((e) => e.error !== undefined && e.result === undefined)).toBe(true);
  });

  it('warns once naming the skipped form when partialSign signs around an unsupported certificate', async () => {
    const { api, target } = await setup();
    const utxo = syntheticOwnedUtxo(config.name, 0, TEST_ADDRESS, 10_000_000n);
    const tx = buildTx({
      inputs: [utxo.input],
      outputs: [{ address: TEST_ADDRESS, lovelace: 9_800_000n }],
      fee: 200_000n,
      certificatesPlaceholder: true,
    });
    expect(target.cardano).toBeDefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await api.signTx(tx, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('certificates');
    warn.mockRestore();
  });

  it('rejects truncated transactions, trailing bytes and a bad is_valid in signTx and submitTx', async () => {
    const { api, target } = await setup();
    const tx = unsignedFor(target);
    expect(tx.endsWith('f5f6')).toBe(true);
    const bad = [
      tx.slice(0, -4), // is_valid and auxiliary data missing
      tx + '00', // trailing byte
      tx.slice(0, -4) + '00f6', // is_valid is an integer
    ];
    for (const hex of bad) {
      await expect(api.signTx(hex, false)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
      await expect(api.submitTx(hex)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
    // Allegra auxiliary data, [metadata, native scripts], is still valid CDDL.
    const allegraAux = tx.slice(0, -2) + '82a080';
    await expect(api.submitTx(allegraAux)).resolves.toMatch(/^[0-9a-f]{64}$/);
    // Integers and tags have no indefinite form.
    await expect(api.submitTx(tx.slice(0, -2) + 'dff6')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    // The indefinite length form of the same transaction stays valid.
    const indefinite = '9f' + tx.slice(2) + 'ff';
    await expect(api.signTx(indefinite, false)).resolves.toMatch(/^[0-9a-f]+$/);
    await expect(api.submitTx(indefinite + '00')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });

  it('refuses a malformed transaction before any prompt quirk, so signHangs never holds it', async () => {
    const { api, control } = await setup({ quirks: { signHangs: true } });
    await expect(api.signTx('84a0', false)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    expect(control.journal.find((e) => e.method === 'signTx')!.error).toBeDefined();
  });

  it('rejects a partialSign that is not a boolean, so "false" cannot switch the form check off', async () => {
    const { api } = await setup();
    const utxo = syntheticOwnedUtxo(config.name, 0, TEST_ADDRESS, 10_000_000n);
    const withCert = buildTx({ inputs: [utxo.input], outputs: [{ address: TEST_ADDRESS, lovelace: 9_800_000n }], fee: 200_000n, certificatesPlaceholder: true });
    const signTx = api.signTx as unknown as (tx: string, partial: unknown) => Promise<string>;
    for (const value of ['false', 'true', 0, 1, null]) {
      await expect(signTx(withCert, value)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
    await expect(signTx(withCert, false)).rejects.toMatchObject({ code: 'CHW_UNSUPPORTED_TX_FORM' });
    await expect(signTx(withCert, undefined)).rejects.toMatchObject({ code: 'CHW_UNSUPPORTED_TX_FORM' });
  });

  it('rejects a complete array of four whose items are not transaction parts', async () => {
    const { api } = await setup();
    // [0, {}, true, null], [{}, 0, true, null], [{}, {}, 0, null], [{}, {}, true, 0]
    for (const bad of ['8400a0f5f6', '84a000f5f6', '84a0a000f6', '84a0a0f500']) {
      await expect(api.submitTx(bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });
});

describe('signData', () => {
  it('returns a COSE signature from the stake key for the reward address that verifies with the reference library', async () => {
    const { api } = await setup();
    const [reward] = await api.getRewardAddresses();
    const payloadHex = bytesToHex(new TextEncoder().encode('hello'));
    const result = await api.signData(reward!, payloadHex);
    const decoded = decodeCoseSign1(hexToBytes(result.signature));
    const key = decodeCoseKey(hexToBytes(result.key));
    expect(bytesToHex(decoded.address!)).toBe(reward);
    expect(ed25519.verify(decoded.signature, oracleSignedData(hexToBytes(result.signature)), key.x)).toBe(true);
    expect(bytesToHex(keyHash(key.x))).toBe(reward!.slice(2));
  });

  it('records the call and honours signDataRejected with UserDeclined', async () => {
    const { api, control } = await setup({ quirks: { signDataRejected: true } });
    const [reward] = await api.getRewardAddresses();
    await expect(api.signData(reward!, '')).rejects.toEqual({ code: 3, info: 'user declined to sign the data' });
    expect(control.journal.filter((e) => e.method === 'signData')).toHaveLength(1);
  });

  it('signs an empty and a 64 KB payload without hashing', async () => {
    const { api } = await setup();
    const change = await api.getChangeAddress();
    for (const payload of ['', '07'.repeat(65536)]) {
      const r = await api.signData(change, payload);
      const d = decodeCoseSign1(hexToBytes(r.signature));
      expect(d.hashed).toBe(false);
      expect(bytesToHex(d.payload)).toBe(payload);
    }
  });

  it('rejects a bech32 address that decodes to zero bytes with InvalidRequest', async () => {
    const { api } = await setup();
    await expect(api.signData('addr1mykd6t', '')).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
  });
});
