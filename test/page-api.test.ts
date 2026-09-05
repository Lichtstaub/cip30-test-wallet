import { describe, expect, it } from 'vitest';
import { Transaction, TransactionWitnessSet } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode } from '../src/core/cbor/decode.js';
import { encode } from '../src/core/cbor/encode.js';
import { txHash } from '../src/core/cbor/tx.js';
import { APIErrorCode, ChwError } from '../src/core/errors.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { enableChw, testConfig } from './helpers/page.js';

const setup = async (overrides = {}) => {
  const target: InstallTarget = {};
  const control = installWallet(testConfig(overrides), target);
  const api = await enableChw(target);
  return { api, control, target };
};

const valueHex = (lovelace: bigint) => bytesToHex(encode(lovelace));

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
  const address = () => hexToBytes('00' + '11'.repeat(28) + '22'.repeat(28));

  const unsignedFor = (target: InstallTarget) => {
    // Spend utxo 0 of the installed wallet. The synthetic id is deterministic.
    const provider = (target.cardano as Record<string, unknown>)['chw'];
    expect(provider).toBeDefined();
    const utxo = syntheticOwnedUtxo(config.name, 0, address(), 10_000_000n);
    return buildTx({ inputs: [utxo.input], outputs: [{ address: address(), lovelace: 9_800_000n }], fee: 200_000n });
  };

  it('signs an owned input and returns only the new witness set', async () => {
    const { api, target } = await setup();
    const ws = await api.signTx(unsignedFor(target), false);
    expect(TransactionWitnessSet.fromCBORHex(ws).toJSON().vkeyWitnesses).toHaveLength(1);
  });

  it('defaults partialSign to false and raises the mock error for an unknown input', async () => {
    const { api } = await setup();
    const unknown = buildTx({ inputs: [{ txId: new Uint8Array(32).fill(9), index: 0n }], outputs: [{ address: address(), lovelace: 1n }], fee: 1n });
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

  it('rejects a complete array of four whose items are not transaction parts', async () => {
    const { api } = await setup();
    // [0, {}, true, null], [{}, 0, true, null], [{}, {}, 0, null], [{}, {}, true, 0]
    for (const bad of ['8400a0f5f6', '84a000f5f6', '84a0a000f6', '84a0a0f500']) {
      await expect(api.submitTx(bad)).rejects.toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });
});
