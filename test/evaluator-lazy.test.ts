// scalus loads on the first submit that runs a script and never before. The
// mock factory runs when something imports scalus, so it counts the loads and
// hands out the real module.
import { describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '../src/core/bytes.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { CheckedLedger } from '../src/host/checks/checked-ledger.js';
import { DEFAULT_MNEMONIC, prepareWallet } from '../src/host/config.js';
import { walletLedger } from '../src/host/ledger.js';
import { syntheticOwnedUtxo } from '../src/page/install.js';
import { buildTx, spliceWitnessSet } from './helpers/build-tx.js';
import { plutusScript } from './helpers/plutus-fixtures.js';
import { foreignConfig, lockedUtxo, plutusSpend } from './helpers/plutus-spend.js';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('scalus', async (importOriginal) => {
  loads.count++;
  return importOriginal();
});

const account = deriveAccount(DEFAULT_MNEMONIC);
const script = plutusScript('v3_always_succeeds');
const locked = lockedUtxo(script, 'lazy-locked');

describe('loading the Plutus evaluator', () => {
  it('prepareWallet, walletLedger and submits without a script never load it, the first Plutus spend does', async () => {
    const w = prepareWallet({ utxos: [{ lovelace: 10_000_000 }, { lovelace: 10_000_000 }, { lovelace: 10_000_000 }], foreignUtxos: [foreignConfig(locked)], ledger: { checks: true } });
    const ledger = walletLedger(w);
    expect(ledger).toBeInstanceOf(CheckedLedger);
    const address = parseAddressArg(w.addresses.payment);
    const utxo = (i: number) => syntheticOwnedUtxo(w.config.name, i, address, 10_000_000n);
    const sign = (tx: string) => hexToBytes(spliceWitnessSet(tx, signWithKeys(tx, [account.payment])));

    await ledger.submit(sign(buildTx({ inputs: [utxo(0).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n })));
    // Refused in phase 1, nothing would run anyway.
    await expect(ledger.submit(sign(buildTx({ inputs: [utxo(1).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 1n })))).rejects.toMatchObject({ code: 2 });
    // is_valid false without a script is PassedUnexpectedly, and that needs no evaluator either.
    await expect(ledger.submit(sign(buildTx({ inputs: [utxo(1).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, isValid: false, extraBodyEntries: new Map([[13n, [[utxo(2).input.txId, 0n]]]]) })))).rejects.toMatchObject({
      info: expect.stringContaining('PassedUnexpectedly'),
    });
    expect(loads.count).toBe(0);

    await ledger.submit(hexToBytes(plutusSpend({ spends: [{ utxo: locked, script }], wallet: utxo(1), changeAddress: address, keys: [account.payment] })));
    expect(loads.count).toBe(1);
  });
});
