// Smoke test: the app starts, signs in, and draws the map.
//
// Nothing leaves the machine. Map tiles are answered from a stubbed route with
// a blank PNG, site-config.json (gitignored, so absent in CI) is answered with
// site-config.example.json, and any other request to a host that is not the
// test server is aborted and fails the test by name.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Mirrors E2E_USER / E2E_PASSWORD in tests/e2e/server.py.
const USER = 'demo';
const PASSWORD = 'demo-password-1';

const SITE_CONFIG = fs.readFileSync(path.join(__dirname, '..', '..', 'site-config.example.json'));
// A 1x1 transparent PNG; Leaflet stretches it to the tile size.
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const TILE_HOST = /(^|\.)tile\.(openstreetmap|opentopomap)\.org$/;

test('the app loads and the map draws its tiles', async ({ page, baseURL }) => {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  const problems = [];
  const external = [];
  let tiles = 0;

  page.on('console', msg => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
  });
  page.on('pageerror', err => problems.push(`page error: ${err.message}`));
  page.on('requestfailed', req => {
    if (!external.includes(req.url())) {
      problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`);
    }
  });
  page.on('response', res => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/site-config.json') {
        return route.fulfill({ contentType: 'application/json', body: SITE_CONFIG });
      }
      return route.fallback();
    }
    if (TILE_HOST.test(url.hostname)) {
      tiles++;
      return route.fulfill({ contentType: 'image/png', body: TILE_PNG });
    }
    external.push(url.href);
    return route.abort('blockedbyclient');
  });

  const login = await page.request.post('/api/login', { data: { username: USER, password: PASSWORD } });
  expect(login.ok(), `login answered ${login.status()}`).toBe(true);

  await page.goto('/');
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  // Desktop shows the tile images. Touch (android, iphone) copies each loaded
  // tile into a canvas and hides the image, see app/map/map-layers.js.
  await expect(page.locator('img.leaflet-tile-loaded').first()).toBeAttached();
  await expect(page.locator('.leaflet-tile-pane')
    .locator('img.leaflet-tile-loaded:visible, canvas:visible').first()).toBeVisible();
  expect(tiles, 'tiles served from the stub').toBeGreaterThan(0);

  // Let late requests (sync, catalog warm-up) settle before judging the logs.
  await page.waitForLoadState('networkidle');
  expect(external, 'requests to hosts outside the test server').toEqual([]);
  expect(problems).toEqual([]);
});
