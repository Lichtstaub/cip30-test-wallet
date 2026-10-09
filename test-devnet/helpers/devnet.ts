// A local Cardano devnet in Docker for the integration suite: cardano-node 11.0.1 on protocol 11
// with Ogmios 7.0.0 and without Kupo. The Shelley genesis funds accounts 0 to 9 of the default
// mnemonic with one UTxO each, at the base address of the account.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cluster, Config } from '@evolution-sdk/devnet';
import { blake2b } from '@noble/hashes/blake2.js';
import { walletAddresses } from '../../src/core/addresses.js';
import { bytesToHex, hexToBytes } from '../../src/core/bytes.js';
import { publicKey } from '../../src/core/keys.js';
import { deriveAccount } from '../../src/derive/index.js';
import { ogmiosCall } from '../../src/host/chain/ogmios.js';
import { DEFAULT_MNEMONIC } from '../../src/host/config.js';

export const NODE_IMAGE = 'ghcr.io/intersectmbo/cardano-node:11.0.1';
export const OGMIOS_IMAGE = 'cardanosolutions/ogmios:v7.0.0';
/** The network magic the devnet package gives every devnet. */
export const DEVNET_MAGIC = 42;
/** Accounts 0 to 9 of the default mnemonic hold one genesis UTxO each. */
export const FUNDED_ACCOUNTS = 10;
/** 10,000 ADA per account. */
export const DEFAULT_LOVELACE_PER_ACCOUNT = 10_000_000_000n;
/** The key hash of the only pool, the one the package's default genesis stakes. */
export const GENESIS_POOL: Uint8Array = hexToBytes(Object.keys(Config.DEFAULT_SHELLEY_GENESIS.staking.pools)[0]!);

// The genesis takes amounts as JSON numbers, this keeps every sum far below 2^53.
const MAX_LOVELACE_PER_ACCOUNT = 100_000_000_000_000n;
const START_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 120_000;
// cardano-node 10.6 and later read only the P2P topology format, the devnet package writes the older one.
const P2P_TOPOLOGY = { localRoots: [], publicRoots: [], useLedgerAfterSlot: -1 };

export interface Devnet {
  ogmiosUrl: string;
  networkMagic: number;
  stop(): Promise<void>;
}

/** The testnet base address of an account of the default mnemonic. */
export function accountAddress(accountIndex: number): Uint8Array {
  const account = deriveAccount(DEFAULT_MNEMONIC, accountIndex);
  return walletAddresses(0, publicKey(account.payment), publicKey(account.stake)).base;
}

/** A genesis UTxO sits at index 0 of a pseudo transaction whose id is Blake2b-256 of the address bytes. */
export function genesisTxId(address: Uint8Array): Uint8Array {
  return blake2b(address, { dkLen: 32 });
}

/** The name of the node container, for docker exec. Cluster.make names it after the cluster. */
export function nodeContainer(name: string): string {
  return `${name}-cardano-node`;
}

/**
 * The Shelley genesis: package defaults, 1 s slots, a block in every slot, protocol 11, the accounts funded.
 * One second leaves a test time to submit a transaction and see it wait in the mempool before the next block.
 */
function shelleyGenesis(lovelacePerAccount: bigint, systemStart: string) {
  const defaults = Config.DEFAULT_SHELLEY_GENESIS;
  // Cluster.make merges each genesis section shallowly, so the default funds stay in by spreading.
  // One of them carries the stake of the only pool, without it no block is forged.
  const initialFunds: Record<string, number> = { ...defaults.initialFunds };
  for (let i = 0; i < FUNDED_ACCOUNTS; i++) initialFunds[bytesToHex(accountAddress(i))] = Number(lovelacePerAccount);
  const total = Object.values(initialFunds).reduce((sum, lovelace) => sum + lovelace, 0);
  return {
    ...defaults,
    slotLength: 1,
    activeSlotsCoeff: 1,
    systemStart,
    initialFunds,
    maxLovelaceSupply: Math.max(defaults.maxLovelaceSupply, total),
    protocolParams: { ...defaults.protocolParams, protocolVersion: { major: 11, minor: 0 } },
  };
}

/** Removes the containers and the socket volume a devnet of this name leaves behind. Absent ones are fine. */
function removeLeftovers(name: string): void {
  for (const suffix of ['cardano-node', 'ogmios', 'kupo']) spawnSync('docker', ['rm', '-f', `${name}-${suffix}`], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', `${name}-ipc`], { stdio: 'ignore' });
}

/** The host directory the devnet package wrote the node configuration to, the source of the node's config mount. */
function configDirOf(cluster: Cluster.Cluster): string {
  const [info] = JSON.parse(execFileSync('docker', ['inspect', cluster.cardanoNode.id], { encoding: 'utf8' })) as Array<{ Mounts?: Array<{ Source: string; Destination: string }> }>;
  const mount = info?.Mounts?.find((m) => m.Destination === '/opt/cardano/config');
  if (!mount) throw new Error(`the container ${cluster.cardanoNode.name} has no config mount`);
  return mount.Source;
}

/**
 * The config directories of a run whose node container never came to exist: the package's temp
 * directories whose Shelley genesis carries this systemStart. Whole seconds make it unique per run.
 */
function configDirsWith(systemStart: string): string[] {
  const root = tmpdir();
  return readdirSync(root)
    .filter((entry) => entry.startsWith('cardano-devnet-'))
    .map((entry) => join(root, entry))
    .filter((dir) => {
      try {
        return (JSON.parse(readFileSync(join(dir, 'genesis-shelley.json'), 'utf8')) as { systemStart?: unknown }).systemStart === systemStart;
      } catch {
        return false;
      }
    });
}

function containerState(container: string): string {
  const inspected = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', container], { encoding: 'utf8' });
  return inspected.status === 0 ? inspected.stdout.trim() : 'missing';
}

function logTail(container: string): string {
  const logs = spawnSync('docker', ['logs', '--tail', '20', container], { encoding: 'utf8' });
  return `${logs.stdout ?? ''}${logs.stderr ?? ''}`.trim();
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cluster.start also returns for a node that crashed at startup. Only a slot above 0 at Ogmios proves blocks. */
async function waitForFirstSlot(url: string, container: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    const state = containerState(container);
    if (state !== 'running') throw new Error(`the devnet node ${container} is ${state}:\n${logTail(container)}`);
    try {
      const answer = await ogmiosCall({ url }, 'queryNetwork/tip');
      if ('result' in answer) {
        const tip = answer.result as { slot?: unknown } | string;
        if (typeof tip === 'object' && tip !== null && typeof tip.slot === 'number' && tip.slot > 0) return;
        last = JSON.stringify(tip);
      } else {
        last = `${answer.error.code} ${answer.error.message}`;
      }
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Ogmios at ${url} reported no slot above 0 within ${READY_TIMEOUT_MS} ms, last answer: ${last}`);
}

/** Starts the protocol 11 devnet with the accounts 0 to 9 of the default mnemonic funded. stop() removes everything it created. */
export async function startDevnet(opts: { name?: string; lovelacePerAccount?: bigint } = {}): Promise<Devnet> {
  const name = opts.name ?? 'chw-devnet';
  const lovelacePerAccount = opts.lovelacePerAccount ?? DEFAULT_LOVELACE_PER_ACCOUNT;
  if (lovelacePerAccount < 1n || lovelacePerAccount > MAX_LOVELACE_PER_ACCOUNT) {
    throw new Error(`lovelacePerAccount must be between 1 and ${MAX_LOVELACE_PER_ACCOUNT}, got ${lovelacePerAccount}`);
  }
  // Whole seconds: Ogmios reports the start time without milliseconds, a fraction would shift slots.
  const startSeconds = Math.floor(Date.now() / 1000);
  const systemStart = new Date(startSeconds * 1000).toISOString();
  removeLeftovers(name);

  let cluster: Cluster.Cluster | undefined;
  let configDir: string | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (cluster) {
      try {
        await Cluster.remove(cluster);
      } catch {
        // removeLeftovers below removes whatever is still there
      }
    }
    // Cluster.remove leaves the socket volume and the config directory behind.
    removeLeftovers(name);
    for (const dir of configDir ? [configDir] : configDirsWith(systemStart)) rmSync(dir, { recursive: true, force: true });
  };

  try {
    cluster = await Cluster.make({
      clusterName: name,
      image: NODE_IMAGE,
      kupo: { enabled: false },
      ogmios: { enabled: true, image: OGMIOS_IMAGE },
      // true makes node 11 look for a Dijkstra genesis the package does not write.
      nodeConfig: { ExperimentalHardForksEnabled: false },
      byronGenesis: { ...Config.DEFAULT_BYRON_GENESIS, startTime: startSeconds },
      shelleyGenesis: shelleyGenesis(lovelacePerAccount, systemStart),
    });
    configDir = configDirOf(cluster);
    writeFileSync(join(configDir, 'topology.json'), JSON.stringify(P2P_TOPOLOGY));
    await withTimeout(Cluster.start(cluster), START_TIMEOUT_MS, 'Cluster.start');
    const port = cluster.ports.ogmios;
    if (port === undefined) throw new Error('the devnet started without an Ogmios port');
    const ogmiosUrl = `http://127.0.0.1:${port}`;
    await waitForFirstSlot(ogmiosUrl, nodeContainer(name));
    return { ogmiosUrl, networkMagic: DEVNET_MAGIC, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
