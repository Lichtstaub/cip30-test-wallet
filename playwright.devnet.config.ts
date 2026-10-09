import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// The chain browser spec in all three engines against a devnet the global setup starts. One worker:
// every engine pays from account 9 of the same devnet, so the engines run one after the other.
export default defineConfig({
  ...base,
  testMatch: 'chain.spec.ts',
  globalSetup: './test-devnet/playwright-setup.ts',
  fullyParallel: false,
  workers: 1,
  // The spec waits up to 30 s for the block, above the default test timeout.
  timeout: 60_000,
});
