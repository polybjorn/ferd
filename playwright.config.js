// Browser tests. A dev-only dependency: nothing here ships, and the app itself
// keeps no build step (docs/architecture.md). Run with `npx playwright test`.
//
// The webServer is tests/e2e/server.py: a throwaway tools/api.py on a free
// loopback port, with a temporary data directory seeded from
// scripts/demo-data.py. It prints its port once the data is in, and the named
// group below puts that port in process.env.FERD_E2E_PORT, which the test
// workers inherit when they load this file.
const { defineConfig, devices } = require('@playwright/test');

const port = process.env.FERD_E2E_PORT;

module.exports = defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: port ? `http://127.0.0.1:${port}` : undefined,
    // A service worker would answer requests out of page.route's sight, and
    // the tests stub routes.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: 'python3 tests/e2e/server.py',
    wait: { stdout: /ferd-e2e ready on port (?<ferd_e2e_port>\d+)/ },
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 60_000,
  },
});
