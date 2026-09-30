import { Assets, NativeScripts, ScriptHash, Transaction } from '@evolution-sdk/evolution';
import { parseAddressArg } from '../src/core/sign-data.js';
import { syntheticOwnedUtxo } from '../src/page/install.js';
import { expect, expectSignedBy, test } from '../src/playwright/index.js';
import { evolutionBuild, evolutionUtxo } from '../test/helpers/evolution-build.js';

type ChwWindow = { cardano: { chw: { enable(): Promise<{ signTx(tx: string, partialSign: boolean): Promise<string> }> } } };

test('an Evolution-built native mint under a stake key policy is signed with the payment and the stake key', async ({ page, wallet }) => {
  const address = parseAddressArg(wallet.addresses.payment);
  const stakeHash = parseAddressArg(wallet.addresses.reward).slice(1);
  const policy = NativeScripts.makeScriptAll([NativeScripts.makeScriptPubKey(stakeHash).script]);
  const policyId = ScriptHash.toHex(ScriptHash.fromScript(policy));
  const own = syntheticOwnedUtxo(wallet.name, 0, address, 10_000_000n);
  const available = [evolutionUtxo(own, address)];
  const tx = await evolutionBuild((b) => b.attachScript({ script: policy }).mintAssets({ assets: Assets.fromHexStrings(policyId, '41', 1n) }), address, available);

  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
  const witnessSet = await page.evaluate(async (hex) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(hex, false), tx);
  expectSignedBy(Transaction.addVKeyWitnessesHex(tx, witnessSet), wallet, { roles: ['payment', 'stake'] });
});
