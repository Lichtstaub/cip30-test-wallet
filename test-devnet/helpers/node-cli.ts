// The node's own verdict on a transaction: cardano-cli inside the devnet's node container submits
// the bytes over the node socket and prints every failed ledger rule, in the node's order. Ogmios
// reports one failure per transaction, this is where the full list comes from.
import { execFileSync } from 'node:child_process';
import { DEVNET_MAGIC } from './devnet.js';

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

// The rule wrappers of Conway's LEDGER, UTXOW, UTXO, UTXOS, CERTS and GOV rules. Every other name is a rule.
const WRAPPERS = new Set(['ConwayUtxowFailure', 'UtxoFailure', 'UtxosFailure', 'ConwayCertsFailure', 'CertFailure', 'DelegFailure', 'PoolFailure', 'GovCertFailure', 'ConwayGovFailure']);

/**
 * The wrappers and the rule name of the first failure in a ConwayApplyTxError, the way the node
 * prints it ('ConwayApplyTxError (x :| [..])') and the way the wallet's info writes it
 * ('ConwayApplyTxError [x, ..]'). For example ['ConwayUtxowFailure', 'UtxoFailure', 'BadInputsUTxO'].
 */
export function headFailure(text: string): string[] {
  const start = /ConwayApplyTxError [([]/.exec(text);
  if (!start) throw new Error(`no ConwayApplyTxError in: ${text.slice(0, 500)}`);
  const word = /\s*\(?\s*([A-Za-z][A-Za-z0-9]*)/y;
  word.lastIndex = start.index + start[0].length;
  const names: string[] = [];
  for (let match = word.exec(text); match; match = word.exec(text)) {
    names.push(match[1]!);
    if (!WRAPPERS.has(match[1]!)) break;
  }
  return names;
}
