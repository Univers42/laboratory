// Runs inside mcr.microsoft.com/playwright (same 1.55.0 as package.json) on
// the host network, so localhost:5180 is the same bench a person opens.
// One worker: the probes share one platform and one cast.
import { defineConfig, devices } from '@playwright/test';

const LAB = process.env.LAB_URL || 'http://localhost:5180';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'report/playwright', open: 'never' }]],
  outputDir: 'report/artifacts',
  use: { baseURL: LAB, video: 'on', screenshot: 'only-on-failure', trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
