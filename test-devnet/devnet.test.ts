import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { ogmiosCall, ogmiosProvider } from '../src/host/chain/ogmios.js';
import { devnetParams, outpoint } from './helpers/chain-wallet.js';
import { accountAddress, DEFAULT_LOVELACE_PER_ACCOUNT, DEVNET_MAGIC, genesisTxId, startDevnet, type Devnet } from './helpers/devnet.js';

// Base address and genesis tx id of accounts 0 to 9 of the default mnemonic, computed with CSL
// and Blake2b-256 of the address bytes, independent of the wallet's own derivation.
const ACCOUNTS: Array<[address: string, genesisTxId: string]> = [
  ['009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc', 'e794ac8dbef778321969bfd133268b8f4eeeeae316dcdaed94aa14277da8ee95'],
  ['00fe3bbd9b3ceb6bae114e6bada9f4a2be193181c0664cb44ca085fdfd337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251', '1e1e544d98a549381adeb8058e776b9e2d9861cf9dcefa61a666ba8593be6740'],
  ['00bd60cd840a94fcb5896799bf82ae2b07076a3875976d68ea8aa49fc2e18e263520478cfa29d61a41bf0af3ff349ec40ec74d7b339739a8e3', 'f77e9fb1bc1ec0fb37fbb4b6211d252d87144bd3e90823423a098faac10dd751'],
  ['005a18abc9e46e1d9ff27599227be9048ef357451f2cc380f19650337376ca0858c08787f2629a64f0bd8946e8699ff2473fc98950a1aadd6e', 'ba591d5778a17c5c9d80b6a92990b2bdbec6c8fda85a7329cb0d033a99ce46e1'],
  ['00eb0baa5e570cffbe2934db29df0b6a3d7c0430ee65d4c3a7ab2fefb91bc428e4720702ebd5dab4fb175324c192dc9bb76cc5da956e3c8dff', 'c9e57a02f7799a69bdfd1ffc3b18eda48ee730fbc88e2198f6b95d5416a4a54e'],
  ['00518874df5997eebbc4c33d5e43d18991fce58a05f38239928c2bc4ae980c858b2eac220ddf2f23fad44cfacbc3501d2b5cf964866c4be93d', 'b9769e3c1acab5a40d6075ddcdd2a0864187bddbf7e26ac99a81e72ddd7d0a9e'],
  ['00de568a37bbb9d5cc154999a416da2876efeb5fd3f07756aeda09f083ae9b46741bf772fda7bfa1a146bbe25bb356aa5602911102a6c11898', 'd3b5e06671667d856ad8f103e707b326a37b9e6b54f316e67b6d1c08103d4395'],
  ['00f18073c489178d73315e31ff34b6d73132278baf222d3d464d172225e39efa2947891ac94d518778446ec22b324c69801fb14b13cc7502bc', '83894c3cadb1574b23a121bd3fa26da48eea5380bbbde1e023fc46f111a5d266'],
  ['00e894d573711ae00ab8138cee7dd6ad6166194fdb986159f3612cd7a96d579861c58a55642d7f931cbcbbddd9703451a625044a179d32a256', '2e5ad9898e8f41b8d3e3b6eee968d80cffad4475b7fbb2661511520430d2c67a'],
  ['00cbcad11458e62cbafd7ffa0d232e0e3eae1278d2f68eb51c7041db5415caedfc1419fc99872126b7e38193e2325c83cf3e81150618da7612', '41e6a1906559582d93cabfc89f2d4a26aadde415f0e266064ab1013678c6bd98'],
];

const NAME = 'chw-devnet-harness';
const configDirs = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith('cardano-devnet-')).sort();
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' }).stdout.trim();

describe('the devnet harness', () => {
  let devnet: Devnet;
  let dirsBefore: string[];

  beforeAll(async () => {
    dirsBefore = configDirs();
    devnet = await startDevnet({ name: NAME });
  });
  afterAll(async () => {
    await devnet?.stop();
  });

  it('funds the base addresses of accounts 0 to 9 at their genesis outpoints', () => {
    ACCOUNTS.forEach(([address, txId], i) => {
      expect(bytesToHex(accountAddress(i))).toBe(address);
      expect(bytesToHex(genesisTxId(accountAddress(i)))).toBe(txId);
    });
  });

  it('runs protocol 11 with 1 s slots and reads the devnet parameters', async () => {
    expect(devnet.networkMagic).toBe(DEVNET_MAGIC);
    const p = await devnetParams(devnet.ogmiosUrl);
    expect(p.protocolMajor).toBe(11n);
    expect({ minFeeA: p.minFeeA, minFeeB: p.minFeeB, keyDeposit: p.keyDeposit, priceMem: p.priceMem, priceSteps: p.priceSteps }).toEqual({
      minFeeA: 44n,
      minFeeB: 155_381n,
      keyDeposit: 0n,
      priceMem: [577n, 10_000n],
      priceSteps: [721n, 10_000_000n],
    });
    expect([p.costModels.PlutusV1.length, p.costModels.PlutusV2.length, p.costModels.PlutusV3.length]).toEqual([166, 0, 251]);
    const answer = await ogmiosCall({ url: devnet.ogmiosUrl }, 'queryLedgerState/eraSummaries');
    const eras = (answer as { result: Array<{ parameters: { slotLength: { milliseconds: number } } }> }).result;
    expect(eras.at(-1)!.parameters.slotLength).toEqual({ milliseconds: 1000 });
  });

  it('shows every account with exactly its genesis UTxO through the Ogmios provider', async () => {
    const provider = ogmiosProvider({ url: devnet.ogmiosUrl });
    expect(await provider.networkId()).toBe(0);
    for (const [i, [address, txId]] of ACCOUNTS.entries()) {
      const utxos = await provider.utxosAt(accountAddress(i));
      expect(utxos.map((u) => outpoint(u.input))).toEqual([`${txId}#0`]);
      expect(utxos[0]!.lovelace).toBe(DEFAULT_LOVELACE_PER_ACCOUNT);
      expect(bytesToHex(utxos[0]!.address)).toBe(address);
    }
  });

  it('removes its containers, its socket volume and its config directory on stop', async () => {
    await devnet.stop();
    expect(docker('ps', '-a', '-q', '--filter', `name=${NAME}-`)).toBe('');
    expect(docker('volume', 'ls', '-q', '--filter', `name=${NAME}-ipc`)).toBe('');
    expect(configDirs()).toEqual(dirsBefore);
  });

  it('refuses an amount per account the genesis cannot take, before it touches Docker', async () => {
    await expect(startDevnet({ name: 'chw-devnet-never', lovelacePerAccount: 0n })).rejects.toThrow(/lovelacePerAccount must be between 1 and/);
    expect(docker('ps', '-a', '-q', '--filter', 'name=chw-devnet-never-')).toBe('');
  });
});
