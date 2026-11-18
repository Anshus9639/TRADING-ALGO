import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results/artifacts',
  use: {
    baseURL: BASE_URL,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  // The e2e build aliases socket.io-client to tests/e2e/socketStub.mjs and reads
  // .env.e2e (a local preview origin, never a deployed backend).
  webServer: {
    command: 'npm run build:e2e && npm run preview:e2e',
    url: BASE_URL,
    timeout: 180000,
    reuseExistingServer: false
  }
});
