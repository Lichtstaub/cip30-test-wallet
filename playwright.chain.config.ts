import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';

// Manual runs against public chains, never in CI. One worker and no retries: a retry of a test
// that submits would send a second real transaction.
export default defineConfig({
  ...base,
  testDir: 'test-chain',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
