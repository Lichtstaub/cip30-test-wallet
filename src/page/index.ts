// Bundle entry. esbuild wraps this file as an IIFE so it can be handed to
// page.addInitScript as one string. The host appends a call to __chwInit
// with the JSON config.
import type { PageConfig } from './config.js';
import { installWallet, type InstallTarget } from './install.js';

declare global {
  // eslint-disable-next-line no-var
  var __chwInit: (config: PageConfig) => void;
}

globalThis.__chwInit = (config: PageConfig) => {
  const target = (typeof window !== 'undefined' ? window : globalThis) as unknown as InstallTarget;
  installWallet(config, target);
};
