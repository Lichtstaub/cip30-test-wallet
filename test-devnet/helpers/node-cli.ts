// The node's own verdict on a transaction: cardano-cli inside the devnet's node container submits
// the bytes over the node socket and prints every failed ledger rule, in the node's order. Ogmios
// reports one failure per transaction, this is where the full list comes from.
import { execFileSync } from 'node:child_process';
import { DEVNET_MAGIC } from './devnet.js';

export { headFailure } from '../../test/helpers/node-failure.js';

/** Submits through cardano-cli in the node container. accepted false carries the node's error text. */
export function cardanoCliSubmit(container: string, txHex: string): { accepted: boolean; text: string } {
  const envelope = JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: txHex });
  const command = `cat > /tmp/chw-tx.json && cardano-cli conway transaction submit --tx-file /tmp/chw-tx.json --testnet-magic ${DEVNET_MAGIC} --socket-path /opt/cardano/ipc/node.socket`;
  try {
    const out = execFileSync('docker', ['exec', '-i', container, 'sh', '-c', command], { input: envelope, stdio: ['pipe', 'pipe', 'pipe'] });
    return { accepted: true, text: out.toString() };
  } catch (error) {
    const failed = error as { stderr?: Buffer; message: string };
    return { accepted: false, text: failed.stderr?.toString() || failed.message };
  }
}

/** cardano-cli's view of a stake address in the node container: one entry with deposit and delegations once registered, none before. */
export function cardanoCliStakeAddressInfo(container: string, stakeAddress: string): Array<Record<string, unknown>> {
  const args = ['exec', container, 'cardano-cli', 'conway', 'query', 'stake-address-info', '--address', stakeAddress];
  const out = execFileSync('docker', [...args, '--testnet-magic', String(DEVNET_MAGIC), '--socket-path', '/opt/cardano/ipc/node.socket'], { encoding: 'utf8' });
  return JSON.parse(out) as Array<Record<string, unknown>>;
}
