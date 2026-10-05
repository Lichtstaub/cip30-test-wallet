import type { Page } from '@playwright/test';
import { Address, Assets, Data, PlutusV3, ScriptHash, Transaction, TransactionHash, UTxO } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { parseAddressArg } from '../src/core/sign-data.js';
import { signWithKeys } from '../src/core/sign-tx.js';
import { deriveAccount } from '../src/derive/index.js';
import { DEFAULT_MNEMONIC } from '../src/host/config.js';
import { syntheticOwnedUtxo } from '../src/page/install.js';
import { expect, test, type WalletHandle } from '../src/playwright/index.js';
import { buildTx, spliceWitnessSet } from '../test/helpers/build-tx.js';
import { evolutionBuild, evolutionUtxo, fixedBudgetEvaluator } from '../test/helpers/evolution-build.js';
import { plutusScript } from '../test/helpers/plutus-fixtures.js';
import { syntheticInput } from '../test/helpers/synthetic.js';

type Api = { signTx(tx: string, partialSign: boolean): Promise<string>; submitTx(tx: string): Promise<string> };
type ChwWindow = { cardano: { chw: { enable(): Promise<Api> } } };

/** What submitTx threw, described inside the page. A thrown plain object does not cross page.evaluate as itself. */
interface Thrown {
  type: string;
  isError: boolean;
  keys: string[];
  name: string | undefined;
  message: string | undefined;
  code: unknown;
  info: unknown;
}

async function open(page: Page) {
  await page.goto('/strict/');
  await expect(page.locator('#wallets')).toHaveText('chw');
}

async function connect(page: Page) {
  await open(page);
  await page.locator('#connect').click();
  await expect(page.locator('#connect-result')).toHaveText('network 0');
}

const signInPage = (page: Page, tx: string) => page.evaluate(async (t) => (await (window as unknown as ChwWindow).cardano.chw.enable()).signTx(t, false), tx);

/** Submits in the page and returns undefined on success, or what the dApp caught. */
const submitInPage = (page: Page, tx: string) =>
  page.evaluate(async (t): Promise<Thrown | undefined> => {
    try {
      await (await (window as unknown as ChwWindow).cardano.chw.enable()).submitTx(t);
      return undefined;
    } catch (e) {
      const o = e as { name?: string; message?: string; code?: unknown; info?: unknown };
      return { type: typeof e, isError: e instanceof Error, keys: Object.keys(e as object), name: o.name, message: o.message, code: o.code, info: o.info };
    }
  }, tx);

/** UTxO 0 of the wallet, 10 ADA. */
const utxo0 = (wallet: WalletHandle) => syntheticOwnedUtxo(wallet.name, 0, parseAddressArg(wallet.addresses.payment), 10_000_000n);

test.describe('ledger checks on', () => {
  test.use({ walletOptions: { ledger: { checks: true } } });

  test('the demo commit passes the checks and the ledger holds its output', async ({ page, wallet }) => {
    await connect(page);
    await page.locator('#commit').click();
    await expect(page.locator('#commit-result')).toHaveText(/^submitted [0-9a-f]{64}$/);
    const id = (await page.locator('#commit-result').textContent())!.replace('submitted ', '');
    expect((await wallet.utxos()).map((u) => u.txId)).toEqual([id]);
  });

  test('a rejected submit reaches the dApp as a plain { code: 2, info } object and changes nothing', async ({ page, wallet }) => {
    await open(page);
    const address = parseAddressArg(wallet.addresses.payment);
    const unbalanced = buildTx({ inputs: [utxo0(wallet).input], outputs: [{ address, lovelace: 9_000_000n }], fee: 200_000n });
    const thrown = await submitInPage(page, spliceWitnessSet(unbalanced, await signInPage(page, unbalanced)));
    expect(thrown).toMatchObject({ type: 'object', isError: false, code: 2 });
    expect(thrown!.keys.sort()).toEqual(['code', 'info']);
    expect(typeof thrown!.info).toBe('string');
    expect(thrown!.info).toContain('ValueNotConservedUTxO');

    expect((await wallet.utxos()).map((u) => u.txId)).toEqual([bytesToHex(utxo0(wallet).input.txId)]);
    expect((await wallet.calls('submitTx')).at(-1)).toMatchObject({ error: { code: 2 } });
    expect(await wallet.lastSubmittedTx()).toBeUndefined();
  });

  test('a harness diagnosis from Node arrives as ChwError with its code in the message', async ({ page, wallet }) => {
    await open(page);
    const address = parseAddressArg(wallet.addresses.payment);
    // Body key 6 (update) is a form the checks cannot judge. Signed in Node, signTx in the page refuses it at partialSign false.
    const update = buildTx({ inputs: [utxo0(wallet).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n, extraBodyEntries: new Map([[6n, [new Map(), 0n]]]) });
    const signed = spliceWitnessSet(update, signWithKeys(update, [deriveAccount(DEFAULT_MNEMONIC).payment]));
    const thrown = await submitInPage(page, signed);
    expect(thrown).toMatchObject({ isError: true, name: 'ChwError', code: 'CHW_UNSUPPORTED_TX_FORM' });
    expect(thrown!.message!.match(/CHW_UNSUPPORTED_TX_FORM/g)).toHaveLength(1);
    expect(thrown!.message).toContain('body key 6 (update)');
  });
});

test.describe('a fee the node would refuse', () => {
  // The demo's fixed fee of 0.2 ADA stays below a minimum raised this way, as a dApp's stale fee would.
  test.use({ walletOptions: { ledger: { checks: true, protocolParams: { minFeeB: 1_000_000 } } } });

  test('the demo commit is refused with FeeTooSmallUTxO and the journal holds the node error', async ({ page, wallet }) => {
    await connect(page);
    await page.locator('#commit').click();
    await expect(page.locator('#commit-result')).not.toHaveText(/^(pending|signing)$/);
    const [call] = await wallet.calls('submitTx');
    expect(call!.error).toMatchObject({ code: 2, info: expect.stringContaining('FeeTooSmallUTxO') });
    expect(await wallet.lastSubmittedTx()).toBeUndefined();
    expect(await wallet.utxos()).toHaveLength(1);
  });
});

test.describe('the submitFails quirk with a node message', () => {
  const REASON = 'ConwayApplyTxError [ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Mismatch (RelGTEQ) {supplied: Coin 150000, expected: Coin 170000})))]';
  test.use({ walletOptions: { quirks: { submitFails: REASON } } });

  test('rejects with exactly the configured info until the test switches it off', async ({ page, wallet }) => {
    await open(page);
    const address = parseAddressArg(wallet.addresses.payment);
    const tx = buildTx({ inputs: [utxo0(wallet).input], outputs: [{ address, lovelace: 9_800_000n }], fee: 200_000n });
    const signed = spliceWitnessSet(tx, await signInPage(page, tx));
    expect(await submitInPage(page, signed)).toMatchObject({ type: 'object', isError: false, code: 2, info: REASON });
    expect((await wallet.utxos()).map((u) => u.txId)).toEqual([bytesToHex(utxo0(wallet).input.txId)]);

    await wallet.setQuirk('submitFails', undefined);
    expect(await submitInPage(page, signed)).toBeUndefined();
    expect(await wallet.utxos()).toHaveLength(1);
    expect((await wallet.utxos())[0]!.txId).not.toBe(bytesToHex(utxo0(wallet).input.txId));
  });
});

/** 5 ADA without a datum at the address of this Plutus V3 validator, for foreignUtxos and for Evolution. */
function lockedBy(scriptCbor: string, seed: string) {
  const script = new PlutusV3.PlutusV3({ bytes: hexToBytes(scriptCbor) });
  const input = syntheticInput(seed, 0n);
  const address = new Address.Address({ networkId: 0, paymentCredential: ScriptHash.fromScript(script) });
  const evo = new UTxO.UTxO({ transactionId: TransactionHash.fromBytes(input.txId), index: 0n, address, assets: Assets.fromLovelace(5_000_000n) });
  const config = { txId: bytesToHex(input.txId), index: 0, addressHex: bytesToHex(Address.toBytes(address)), lovelace: 5_000_000 };
  return { script, input, evo, config };
}

const succeeds = lockedBy(plutusScript('v3_always_succeeds').cborHex, 'browser-plutus-succeeds');
const fails = lockedBy(plutusScript('v3_always_fails').cborHex, 'browser-plutus-fails');

test.describe('Plutus scripts under the ledger checks', () => {
  test.use({ walletOptions: { utxos: [{ lovelace: 50_000_000 }, { lovelace: 10_000_000 }], foreignUtxos: [succeeds.config, fails.config], ledger: { checks: true } } });

  /** A spend of the locked UTxO with its validator attached, collateral and change from the wallet, built in Node by Evolution. */
  const spend = (wallet: WalletHandle, locked: ReturnType<typeof lockedBy>) => {
    const address = parseAddressArg(wallet.addresses.payment);
    const own = [0, 1].map((i) => syntheticOwnedUtxo(wallet.name, i, address, [50_000_000n, 10_000_000n][i]!));
    return evolutionBuild(
      (b) => b.collectFrom({ inputs: [locked.evo], redeemer: Data.constr(0n, []) }).attachScript({ script: locked.script }),
      address,
      own.map((u) => evolutionUtxo(u, address)),
      { evaluator: fixedBudgetEvaluator },
    );
  };

  test('a spend from always_succeeds is signed in the page, runs in Node and is accepted', async ({ page, wallet }) => {
    await open(page);
    const tx = await spend(wallet, succeeds);
    const signed = Transaction.addVKeyWitnessesHex(tx, await signInPage(page, tx));
    expect(await submitInPage(page, signed)).toBeUndefined();
    expect(await wallet.lastSubmittedTx()).toBe(signed);
    const [call] = await wallet.calls('submitTx');
    const id = call!.result as string;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // The change of the spend is a new wallet output.
    expect((await wallet.utxos()).map((u) => u.txId)).toContain(id);
  });

  test('always_fails with is_valid true reaches the dApp as a plain { code: 2, info } naming ValidationTagMismatch', async ({ page, wallet }) => {
    await open(page);
    const before = await wallet.utxos();
    const tx = await spend(wallet, fails);
    const thrown = await submitInPage(page, Transaction.addVKeyWitnessesHex(tx, await signInPage(page, tx)));
    expect(thrown).toMatchObject({ type: 'object', isError: false, code: 2 });
    expect(thrown!.keys.sort()).toEqual(['code', 'info']);
    expect(thrown!.info).toContain('ValidationTagMismatch');
    expect(thrown!.info).toContain('FailedUnexpectedly');
    expect(await wallet.utxos()).toEqual(before);
    expect(await wallet.lastSubmittedTx()).toBeUndefined();
  });
});
