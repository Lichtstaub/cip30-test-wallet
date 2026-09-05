import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test-browser',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'node examples/minimal-dapp/serve.mjs',
    url: 'http://localhost:4173/strict/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
