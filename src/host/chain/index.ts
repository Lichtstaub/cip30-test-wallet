// The chain mode in Node: the client the options name, and what attachWallet
// checks before anything reaches the page.
import type { ChainOptions, PreparedWallet } from '../config.js';
import { chainLedger } from '../ledger.js';
import type { ChainLedger } from './chain-ledger.js';
import { koiosProvider } from './koios.js';
import { ogmiosProvider } from './ogmios.js';
import type { ChainProvider } from './provider.js';

/** The provider for these options. */
export function chainProvider(options: ChainOptions): ChainProvider {
  if (options.provider === 'ogmios') return ogmiosProvider({ url: options.url });
  return koiosProvider(options);
}

const networkName = (id: 0 | 1) => (id === 1 ? 'mainnet (networkId 1)' : 'a test network (networkId 0)');

/**
 * The provider's network must be the one the wallet's addresses are for, checked before the
 * page loads. On mainnet signTx stays locked unless the options allow signing there, an
 * offline wallet has no lock because its signatures move nothing.
 */
export async function connectChain(prepared: PreparedWallet, provider: ChainProvider): Promise<{ ledger: ChainLedger; signLocked: boolean }> {
  const reported = await provider.networkId();
  const expected = prepared.config.networkId;
  if (reported !== expected) throw new Error(`ledger.chain: ${provider.name} reports ${networkName(reported)}, walletOptions.networkId is ${expected}`);
  return { ledger: chainLedger(prepared, provider), signLocked: reported === 1 && prepared.chain?.allowMainnetSigning !== true };
}
