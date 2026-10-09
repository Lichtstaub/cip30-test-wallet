// Global setup of playwright.devnet.config.ts: one devnet for the chain browser spec. A URL that
// is already set in CHW_DEVNET_OGMIOS wins, then nothing is started here.
import { startDevnet } from './helpers/devnet.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.CHW_DEVNET_OGMIOS) return async () => {};
  const devnet = await startDevnet({ name: 'chw-devnet-browser' });
  // Workers start after the global setup and inherit this.
  process.env.CHW_DEVNET_OGMIOS = devnet.ogmiosUrl;
  return () => devnet.stop();
}
