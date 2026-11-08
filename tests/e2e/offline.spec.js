// Offline: after one load the app shell opens with the network off, and an
// edit made offline applies at once and reaches the API after reconnecting
// (docs/architecture.md, Platform targets; docs/pwa.md).
//
// This is the one spec that lets the service worker run: it is what serves
// the shell offline. The page.route fence cannot see requests the worker
// answers, so the test records what leaves the page itself instead.
const { test, expect } = require('@playwright/test');
const { signUp, isPhone } = require('./helpers');

test.use({ serviceWorkers: 'allow' });

/** Resolves once the worker has installed (its shell precache is complete), activated and controls the page. */
async function controlled(/** @type {import('@playwright/test').Page} */ page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  // clients.claim() may land after the first load; a reload makes it certain.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('the shell loads offline and an offline edit syncs on reconnect', async ({ page, context, baseURL }, info) => {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  const phone = isPhone(info);
  const name = 'E2E offline place';
  const errors = /** @type {string[]} */ ([]);
  // WebKit raises a page error for each request the worker cannot answer
  // offline: tiles never viewed before (docs/pwa.md says those need network).
  // That is not the target under test.
  const expected = /Response served by service worker is an error|Cannot load \./;
  page.on('pageerror', err => {
    if (!expected.test(err.message)) errors.push(`page error: ${err.message}`);
  });
  // Tiles are fetched by the worker, outside page.route; only same-origin
  // traffic and tile hosts are expected from the page.
  const stray = /** @type {string[]} */ ([]);
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.origin !== origin && !/(^|\.)tile\.(openstreetmap|opentopomap)\.org$/.test(url.hostname)) {
      stray.push(url.href);
    }
  });

  await signUp(page, info);
  await controlled(page);
  await expect(page.locator('.leaflet-container').first()).toBeVisible();

  // Network off, then a cold reload: the worker answers the shell and the
  // app reads its data from the device.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  await expect(page.locator('#pwa-offline-banner')).toBeVisible();

  // An edit offline: it shows in the list at once and the banner counts it.
  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await expect(page.locator('#add-tabs')).toBeVisible();
  await page.locator('#p-name').fill(name);
  await page.locator('#p-coords-manual').click();
  await page.locator('#p-lat').fill('46.47');
  await page.locator('#p-lon').fill('9.82');
  await page.locator('#place-submit').click();
  await expect(page.locator('#add-tabs')).toBeHidden();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  if (phone) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/places"]').click();
  } else {
    await page.locator('#tab-places').click();
  }
  await page.locator('#search-input').fill(name);
  await expect(page.locator('.place-card').filter({ hasText: name })).toHaveCount(1);
  await expect(page.locator('#pwa-offline-text')).toContainText('1');

  // The settings group is a lazy import; the worker has to hold it too.
  await page.locator('#auth-menu-btn:visible, #bar-you:visible').click();
  await page.locator('#auth-menu [data-action=settings]:visible, #you-gear:visible').click();
  await page.locator('.account-sheet [data-action=settings]:visible, #settings-tabs [aria-pressed="true"]').first().click();
  await expect(page.locator('#settings-tabs [data-tab="general"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  // Reconnect: the edit reaches the API and the banner goes.
  await context.setOffline(false);
  // Firefox under Playwright flips navigator.onLine without firing the
  // 'online' event the app syncs on; a real browser fires it.
  if (info.project.name === 'firefox') await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => {
    const places = await (await page.request.get('/api/places')).json();
    return places.map((/** @type {{ name: string }} */ p) => p.name);
  }, { timeout: 20_000 }).toContain(name);
  await expect(page.locator('#pwa-offline-banner')).toBeHidden();

  expect(stray, 'requests outside the test server and the tile hosts').toEqual([]);
  expect(errors).toEqual([]);
});
