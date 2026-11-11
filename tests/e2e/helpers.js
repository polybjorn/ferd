// Shared setup for the browser tests: the network fence the smoke test
// started with, a sign-in, and selectors that differ between the desktop and
// phone layouts.
//
// The projects run at once against one server. A test that only reads signs in
// as the demo account and its seeded data. A test that writes (adds, deletes,
// or sets a synced preference) signs up an empty account of its own with
// signUp, so no page another test has open sees its half-done state.
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@playwright/test');

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

/**
 * Keep the page on the test server: tiles get a blank PNG, site-config.json
 * (gitignored, so absent in CI) gets the example, and any other host is
 * aborted and recorded. Returns the lists the test asserts on.
 * @param {import('@playwright/test').Page} page
 * @param {string} baseURL
 */
async function fence(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const fenced = { external: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]), tiles: 0 };
  page.on('pageerror', err => fenced.errors.push(`page error: ${err.message}`));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/site-config.json') {
        return route.fulfill({ contentType: 'application/json', body: SITE_CONFIG });
      }
      return route.fallback();
    }
    if (TILE_HOST.test(url.hostname)) {
      fenced.tiles++;
      return route.fulfill({ contentType: 'image/png', body: TILE_PNG });
    }
    fenced.external.push(url.href);
    return route.abort('blockedbyclient');
  });
  return fenced;
}

// Room for the app's own retry of a stalled session check (STATE_TIMEOUT_MS
// in app/main.js) on a loaded CI runner.
const FIRST_LOAD_MS = 12_000;

/**
 * Sign in through the API and open the app at hash.
 * @param {import('@playwright/test').Page} page
 */
async function signIn(page, hash = '') {
  const login = await page.request.post('/api/login', { data: { username: USER, password: PASSWORD } });
  expect(login.ok(), `login answered ${login.status()}`).toBe(true);
  await page.goto('/' + hash);
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible({ timeout: FIRST_LOAD_MS });
}

/**
 * Sign up a fresh, empty account (the test server leaves registration open),
 * which signs the page in, and open the app at hash.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} info
 */
async function signUp(page, info, hash = '') {
  const username = `e2e-${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await page.request.post('/api/register', { data: { username, password: PASSWORD } });
  expect(res.ok(), `register answered ${res.status()}`).toBe(true);
  await page.goto('/' + hash);
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible({ timeout: FIRST_LOAD_MS });
  return username;
}

/** A phone project has the bottom bar in place of the top nav. */
function isPhone(/** @type {import('@playwright/test').TestInfo} */ info) {
  return ['android', 'iphone'].includes(info.project.name);
}

/** The open modal: the newest dialog in the stack. */
function dialog(/** @type {import('@playwright/test').Page} */ page) {
  return page.locator('.ui-dialog').last();
}

module.exports = { USER, PASSWORD, fence, signIn, signUp, isPhone, dialog };
