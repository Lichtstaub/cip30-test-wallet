// update_drep on preprod through the fixture: the wallet of CHW_CHAIN_MNEMONIC, whose DRep is
// registered, refreshes it with a real transaction that costs test ADA.
// Manual, never in CI: CHW_CHAIN_MNEMONIC='...' npm run test:chain -- preprod-drep
import { hexToBytes } from '../src/core/bytes.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { KOIOS_URLS } from '../src/host/chain/koios.js';
import { expect, expectSignedBy, test } from '../src/playwright/index.js';
import { buildTx, spliceWitnessSet } from '../test/helpers/build-tx.js';

const MNEMONIC = process.env.CHW_CHAIN_MNEMONIC;
const KOIOS = KOIOS_URLS.preprod;

type Api = { signTx(tx: string, partialSign: boolean): Promise<string>; submitTx(tx: string): Promise<string> };
type ChwWindow = { cardano: { chw: { enable(): Promise<Api> } } };
interface DrepInfo {
  drep_status: string;
  active: boolean;
  expires_epoch_no: number;
}

test.skip(!MNEMONIC, 'needs CHW_CHAIN_MNEMONIC, the mnemonic of a funded preprod wallet whose DRep is registered');
test.use({ walletOptions: MNEMONIC ? { mnemonic: MNEMONIC, ledger: { chain: { provider: 'koios', network: 'preprod' } } } : {} });

async function koios<T>(path: string, body?: unknown): Promise<T> {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(`${KOIOS}${path}`, init);
  if (!response.ok) throw new Error(`Koios ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

test('update_drep through the fixture is confirmed and the DRep stays active', async ({ page, wallet }) => {
  const [before] = await koios<DrepInfo[]>('/drep_info', { _drep_ids: [wallet.drepId] });
  expect(before, `${wallet.drepId} has to be a registered DRep on preprod`).toMatchObject({ drep_status: 'registered' });

  const input = (await wallet.utxos()).find((u) => Object.keys(u.assets ?? {}).length === 0 && !u.datumHash && !u.inlineDatum && !u.scriptRef && BigInt(u.lovelace) >= 5_000_000n);
  expect(input, 'a pure ADA UTxO of at least 5 ADA at the base address').toBeDefined();
  const fee = 300_000n;
  const tx = buildTx({
    inputs: [{ txId: hexToBytes(input!.txId), index: BigInt(input!.index) }],
    outputs: [{ address: parseAddressArg(wallet.addresses.payment), lovelace: BigInt(input!.lovelace) - fee }],
    fee,
    // update_drep_cert = (18, drep_credential, anchor / null), the anchor stays as it is
    extraBodyEntries: new Map([[4n, [[18n, [0n, hexToBytes(wallet.drepKeyHashHex)], null]]]]),
  });

  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  const witnessSet = await page.evaluate(async (hex) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(hex, false), tx);
  const signed = spliceWitnessSet(tx, witnessSet);
  expectSignedBy(signed, wallet, { roles: ['payment', 'drep'] });
  const id = await page.evaluate(async (hex) => (await (window as unknown as ChwWindow).cardano.chw.enable()).submitTx(hex), signed);

  await expect
    .poll(async () => (await koios<Array<{ num_confirmations: number | null }>>('/tx_status', { _tx_hashes: [id] }))[0]?.num_confirmations ?? 0, { timeout: 10 * 60_000, intervals: [15_000] })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await koios<Array<{ update_tx_hash: string; action: string }>>(`/drep_updates?_drep_id=${wallet.drepId}`)).some((u) => u.update_tx_hash === id && u.action === 'updated'), {
      timeout: 5 * 60_000,
      intervals: [15_000],
    })
    .toBe(true);
  const [after] = await koios<DrepInfo[]>('/drep_info', { _drep_ids: [wallet.drepId] });
  expect(after).toMatchObject({ drep_status: 'registered', active: true });
  expect(after!.expires_epoch_no).toBeGreaterThanOrEqual(before!.expires_epoch_no);
  test.info().annotations.push({ type: 'DRep expiry', description: `epoch ${before!.expires_epoch_no} before, ${after!.expires_epoch_no} after, tx ${id}` });
});
