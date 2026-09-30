import { describe, expect, it } from 'vitest';
import { baseAddressBytes, enterpriseAddressBytes } from '../src/core/addresses.js';
import { bytesToHex, concat, hexToBytes } from '../src/core/bytes.js';
import { Tagged } from '../src/core/cbor/decode.js';
import { parseTransaction } from '../src/core/cbor/tx.js';
import { keyHash, publicKey } from '../src/core/keys.js';
import { MemoryLedger, paysTo, type Utxo, type WalletCredentials } from '../src/core/ledger.js';
import { deriveAccount } from '../src/derive/index.js';
import { prepareWallet } from '../src/host/config.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { installWallet, syntheticOwnedUtxo, type InstallTarget } from '../src/page/install.js';
import { buildTx } from './helpers/build-tx.js';
import { chwProvider, enableChw } from './helpers/page.js';
import { hash28 as h, syntheticInput } from './helpers/synthetic.js';
import { MNEMONIC } from './fixtures/vectors.js';

const me = deriveAccount(MNEMONIC);
const other = deriveAccount(MNEMONIC, 1);
const myPay = keyHash(publicKey(me.payment));
const myStake = keyHash(publicKey(me.stake));
const wallet: WalletCredentials = { paymentKeyHash: myPay, stakeKeyHash: myStake, networkId: 0 };
const myAddress = baseAddressBytes(0, myPay, myStake);
const otherAddress = baseAddressBytes(0, keyHash(publicKey(other.payment)), myStake);
const mine = (seed: string, lovelace = 10_000_000n): Utxo => ({ input: syntheticInput(seed, 0n), address: myAddress, lovelace });
const outpoints = (...utxos: Utxo[]) => new Tagged(258n, utxos.map((u) => [u.input.txId, u.input.index]));
const idOf = (tx: string) => parseTransaction(hexToBytes(tx)).hash;
const keys = (utxos: Utxo[]) => utxos.map((u) => `${bytesToHex(u.input.txId)}#${u.input.index}`);

describe('state after submit', () => {
  it('a valid transaction spends its inputs and creates its outputs, owned by payment credential', async () => {
    const a = mine('state-a');
    const ledger = new MemoryLedger({ owned: [a], wallet });
    const tx = buildTx({ inputs: [a.input], outputs: [{ address: myAddress, lovelace: 6_000_000n }, { address: otherAddress, lovelace: 3_800_000n }], fee: 200_000n });
    const id = bytesToHex(idOf(tx));
    await ledger.submit(hexToBytes(tx));
    expect(keys(await ledger.getWalletUtxos())).toEqual([`${id}#0`]);
    expect((await ledger.resolveInput({ txId: hexToBytes(id), index: 1n }))?.lovelace).toBe(3_800_000n);
    // A spent output stays resolvable for signTx, a wallet has seen it.
    expect(await ledger.resolveInput(a.input)).toEqual(a);
  });

  it('an invalid transaction spends only its collateral and creates only the collateral return, at index = number of outputs', async () => {
    const a = mine('state-input');
    const c = mine('state-collateral', 5_000_000n);
    const ledger = new MemoryLedger({ owned: [a, c], wallet });
    const tx = buildTx({
      inputs: [a.input],
      outputs: [{ address: otherAddress, lovelace: 1n }, { address: otherAddress, lovelace: 2n }],
      fee: 200_000n,
      isValid: false,
      extraBodyEntries: new Map<bigint, unknown>([
        [13n, outpoints(c)],
        [16n, [myAddress, 4_500_000n]],
        [4n, [[7n, [0n, myStake], 2_000_000n]]],
      ]),
    });
    const id = bytesToHex(idOf(tx));
    await ledger.submit(hexToBytes(tx));
    expect(keys(await ledger.getWalletUtxos())).toEqual([...keys([a]), `${id}#2`]);
    expect(await ledger.getStakeRegistered()).toBe(false);
  });

  it('an invalid transaction without collateral return only spends its collateral', async () => {
    const a = mine('state-no-return');
    const c = mine('state-no-return-collateral', 5_000_000n);
    const ledger = new MemoryLedger({ owned: [a, c], wallet });
    const tx = buildTx({ inputs: [a.input], outputs: [{ address: myAddress, lovelace: 1n }], fee: 1n, isValid: false, extraBodyEntries: new Map<bigint, unknown>([[13n, outpoints(c)]]) });
    await ledger.submit(hexToBytes(tx));
    expect(keys(await ledger.getWalletUtxos())).toEqual(keys([a]));
  });

  it('the same transaction submitted twice changes the state once', async () => {
    const a = mine('state-twice');
    const ledger = new MemoryLedger({ owned: [a], wallet });
    const tx = hexToBytes(buildTx({ inputs: [a.input], outputs: [{ address: myAddress, lovelace: 9_000_000n }], fee: 1n }));
    await ledger.submit(tx);
    await ledger.submit(tx);
    expect(await ledger.getWalletUtxos()).toHaveLength(1);
    expect(ledger.submitted).toHaveLength(2);
  });

  it('state: false keeps the configured UTxOs', async () => {
    const a = mine('state-off');
    const ledger = new MemoryLedger({ owned: [a], wallet, state: false });
    await ledger.submit(hexToBytes(buildTx({ inputs: [a.input], outputs: [{ address: myAddress, lovelace: 1n }], fee: 1n })));
    expect(await ledger.getWalletUtxos()).toEqual([a]);
  });

  it('without wallet credentials every new output is foreign', async () => {
    const a = mine('state-no-wallet');
    const ledger = new MemoryLedger({ owned: [a] });
    await ledger.submit(hexToBytes(buildTx({ inputs: [a.input], outputs: [{ address: myAddress, lovelace: 1n }], fee: 1n })));
    expect(await ledger.getWalletUtxos()).toEqual([]);
  });
});

describe('ownership', () => {
  it('base and enterprise addresses with the wallet payment key are owned, a script address with the same bytes is not', () => {
    expect(paysTo(myAddress, myPay, 0)).toBe(true);
    expect(paysTo(enterpriseAddressBytes(0, myPay), myPay, 0)).toBe(true);
    expect(paysTo(concat(Uint8Array.of(0x70), myPay), myPay, 0)).toBe(false);
    expect(paysTo(otherAddress, myPay, 0)).toBe(false);
  });

  it('the wallet payment key on another network is not owned', () => {
    expect(paysTo(baseAddressBytes(1, myPay, myStake), myPay, 0)).toBe(false);
  });
});

describe('stake registration from certificates', () => {
  const run = async (certificates: unknown[], start = false) => {
    const a = mine(`state-cert-${certificates.length}-${String(start)}`);
    const ledger = new MemoryLedger({ owned: [a], wallet, stakeRegistered: start });
    await ledger.submit(hexToBytes(buildTx({ inputs: [a.input], outputs: [], fee: 1n, extraBodyEntries: new Map([[4n, certificates]]) })));
    return ledger.getStakeRegistered();
  };

  it.each([
    ['0 account_registration', [[0n, [0n, myStake]]], false, true],
    ['7 account_registration_deposit', [[7n, [0n, myStake], 2_000_000n]], false, true],
    ['11 registration with pool delegation', [[11n, [0n, myStake], h(5), 2_000_000n]], false, true],
    ['12 registration with DRep delegation', [[12n, [0n, myStake], [0n, h(6)], 2_000_000n]], false, true],
    ['13 registration with both delegations', [[13n, [0n, myStake], h(5), [0n, h(6)], 2_000_000n]], false, true],
    ['1 account_unregistration', [[1n, [0n, myStake]]], true, false],
    ['8 account_unregistration_deposit', [[8n, [0n, myStake], 2_000_000n]], true, false],
    ['registration and unregistration in one transaction', [[7n, [0n, myStake], 2_000_000n], [8n, [0n, myStake], 2_000_000n]], false, false],
    ['a foreign stake key', [[7n, [0n, h(3)], 2_000_000n]], false, false],
    ['a script credential with the same bytes', [[7n, [1n, myStake], 2_000_000n]], false, false],
  ])('%s', async (_name, certificates, start, expected) => {
    expect(await run(certificates as unknown[], start as boolean)).toBe(expected);
  });
});

describe('the page wallet', () => {
  it('CIP-95 reports the registration a submitted transaction made, getUtxos the new outputs', async () => {
    const w = prepareWallet();
    const target: InstallTarget = {};
    installWallet(w.config, target);
    const api = await enableChw(target);
    const address = parseAddressArg(w.addresses.payment);
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    const spend = buildTx({
      inputs: [utxo0.input],
      outputs: [{ address, lovelace: 7_000_000n }],
      fee: 1_000_000n,
      extraBodyEntries: new Map([[4n, [[7n, [0n, keyHash(hexToBytes(w.stakePublicKeyHex))], 2_000_000n]]]]),
    });
    await api.submitTx(spend);
    const { cip95 } = (await chwProvider(target).enable({ extensions: [{ cip: 95 }] })) as unknown as { cip95: { getRegisteredPubStakeKeys(): Promise<string[]> } };
    expect(await cip95.getRegisteredPubStakeKeys()).toEqual([w.stakePublicKeyHex]);
    const after = (await api.getUtxos())!;
    expect(after).toHaveLength(1);
    expect(after[0]).toContain(bytesToHex(idOf(spend)));
  });

  it('the wallet address stays used after every UTxO it held was spent to another address', async () => {
    const w = prepareWallet();
    const target: InstallTarget = {};
    installWallet(w.config, target);
    const api = await enableChw(target);
    const address = parseAddressArg(w.addresses.payment);
    const used = await api.getUsedAddresses();
    const utxo0 = syntheticOwnedUtxo(w.config.name, 0, address, 10_000_000n);
    await api.submitTx(buildTx({ inputs: [utxo0.input], outputs: [{ address: otherAddress, lovelace: 9_000_000n }], fee: 1_000_000n }));
    expect(await api.getUtxos()).toEqual([]);
    expect(await api.getUsedAddresses()).toEqual(used);
    expect(await api.getUnusedAddresses()).toEqual([]);
  });
});
