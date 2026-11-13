// The Content-Security-Policy, enforced: an injected inline script does not
// run, and the app still signs in and draws the map under the policy.
//
// The test server enforces the policy (FERD_CSP_MODE in tests/e2e/server.py),
// so this checks the value that ships rather than a copy.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Mirrors E2E_USER / E2E_PASSWORD in tests/e2e/server.py.
const USER = 'demo';
const PASSWORD = 'demo-password-1';

const SITE_CONFIG = fs.readFileSync(path.join(__dirname, '..', '..', 'site-config.example.json'));
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const TILE_HOST = /(^|\.)tile\.(openstreetmap|opentopomap)\.org$/;

test('the enforced policy blocks an injected inline script and the app still runs', async ({ page, baseURL }) => {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  /** @type {string[]} */
  const served = [];

  await page.addInitScript(() => {
    /** @type {any} */ (window).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => {
      /** @type {any} */ (window).__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === '/site-config.json') {
        return route.fulfill({ contentType: 'application/json', body: SITE_CONFIG });
      }
      if (request.resourceType() === 'document') {
        const response = await route.fetch();
        const policy = response.headers()['content-security-policy'];
        if (policy) served.push(policy);
        const body = (await response.text())
          .replace('<head>', '<head><script>window.__injected = true;</script>');
        return route.fulfill({ response, body });
      }
      return route.fallback();
    }
    if (TILE_HOST.test(url.hostname)) {
      return route.fulfill({ contentType: 'image/png', body: TILE_PNG });
    }
    return route.abort('blockedbyclient');
  });

  const login = await page.request.post('/api/login', { data: { username: USER, password: PASSWORD } });
  expect(login.ok(), `login answered ${login.status()}`).toBe(true);

  await page.goto('/');
  expect(served, 'the page was served with an enforced policy').toHaveLength(1);
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  await expect(page.locator('img.leaflet-tile-loaded').first()).toBeAttached();
  await page.waitForLoadState('networkidle');

  expect(await page.evaluate(() => /** @type {any} */ (window).__injected)).toBeUndefined();
  // The injected script is the one thing the policy should stop. Whether the
  // listener saw it varies by engine, so only the others are judged.
  const violations = /** @type {string[]} */ (await page.evaluate(() => /** @type {any} */ (window).__cspViolations || []));
  expect(violations.filter(v => !/ inline$/.test(v))).toEqual([]);
});
