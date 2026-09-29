import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import { hexToBytes } from '../src/core/bytes.js';
import { APIErrorCode, TxSignErrorCode } from '../src/core/errors.js';
import { prepareWallet } from '../src/host/config.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { enableChw } from './helpers/page.js';
import { bech32 } from '@scure/base';

const prepared = (quirks = {}) => prepareWallet({ quirks });
const addressOf = (w: ReturnType<typeof prepareWallet>) => Uint8Array.from(bech32.fromWords(bech32.decode(w.addresses.payment, false).words));
const govActionId = [new Uint8Array(32).fill(3), 0n];

function voteTx(w: ReturnType<typeof prepareWallet>, extra: Array<[bigint, unknown]> = []) {
  const utxo = syntheticOwnedUtxo('chw', 0, addressOf(w), 10_000_000n);
  const votes = new Map([[[2n, hexToBytes(w.drepKeyHashHex)], new Map([[govActionId, [1n, null]]])]]);
  return buildTx({ inputs: [utxo.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[19n, votes], ...extra]) });
}

async function api(w: ReturnType<typeof prepareWallet>) {
  const target: InstallTarget = {};
  const control = installWallet(w.config, target);
  return { api: await enableChw(target), control };
}

// Evolution's toJSON() gives a VKey object, not a hex string, see test/witness.test.ts:44.
const vkeys = (ws: string) => (TransactionWitnessSet.fromCBORHex(ws).toJSON().vkeyWitnesses ?? []).map((x) => VKey.toHex(x.vkey));

afterEach(() => vi.restoreAllMocks());

describe('page signTx with governance forms', () => {
  it('signs a DRep vote with payment and DRep key', async () => {
    const w = prepared();
    const { api: a } = await api(w);
    expect(vkeys(await a.signTx(voteTx(w), false)).sort()).toEqual([w.paymentPublicKeyHex, w.drepPublicKeyHex].sort());
  });

  it('noCip95: the DRep vote is foreign, ProofGeneration, and partialSign true gives only the payment witness', async () => {
    const w = prepared({ noCip95: true });
    const { api: a } = await api(w);
    await expect(a.signTx(voteTx(w), false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
    expect(vkeys(await a.signTx(voteTx(w), true))).toEqual([w.paymentPublicKeyHex]);
  });

  it('noCip95 set at runtime takes effect on the next signTx', async () => {
    const w = prepared();
    const { api: a, control } = await api(w);
    control.setQuirk('noCip95', true);
    await expect(a.signTx(voteTx(w), false)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.ProofGeneration }));
  });

  it('a deprecated certificate is code 3 even at partialSign true and before signHangs, without a release', async () => {
    const w = prepared({ signHangs: true });
    const { api: a } = await api(w);
    const tx = voteTx(w, [[4n, [[5n, 'anything']]]]);
    for (const partial of [false, true]) {
      await expect(a.signTx(tx, partial)).rejects.toEqual(expect.objectContaining({ code: TxSignErrorCode.DeprecatedCertificate }));
    }
  });

  it('partialSign true warns about a script certificate, not about supported governance forms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = prepared();
    const { api: a } = await api(w);
    await a.signTx(voteTx(w), true);
    expect(warn).not.toHaveBeenCalled();
    await a.signTx(voteTx(w, [[4n, [[9n, [1n, new Uint8Array(28)], [0n, hexToBytes(w.drepKeyHashHex)]]]]]), true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('with a script credential'));
  });

  it('a malformed governance field is InvalidRequest before signHangs or signRejected, at both partialSign values', async () => {
    for (const quirk of ['signHangs', 'signRejected']) {
      const w = prepared({ [quirk]: true });
      const { api: a } = await api(w);
      const tx = voteTx(w, [[4n, [[9n, [0n, new Uint8Array(27)], [0n, hexToBytes(w.drepKeyHashHex)]]]]]);
      for (const partial of [false, true]) {
        const caught = await a.signTx(tx, partial).catch((e: unknown) => e);
        expect(caught).not.toBeInstanceOf(Error);
        expect(caught).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
      }
    }
  });

  it('a malformed certificate reaches the dApp as InvalidRequest at both partialSign values', async () => {
    const w = prepared();
    const { api: a } = await api(w);
    const poolWithBadOwners = [3n, new Uint8Array(28).fill(5), new Uint8Array(32), 1n, 340_000_000n, [0n, 1n], hexToBytes('e0' + '01'.repeat(28)), 7n, [], null];
    for (const partial of [false, true]) {
      const caught = await a.signTx(voteTx(w, [[4n, [poolWithBadOwners]]]), partial).catch((e: unknown) => e);
      expect(caught).not.toBeInstanceOf(Error);
      expect(caught).toEqual(expect.objectContaining({ code: APIErrorCode.InvalidRequest }));
    }
  });
});
