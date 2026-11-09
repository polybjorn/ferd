// The list pages load through import() the first time each is opened
// (app/router.js). Two things must hold: a hash change that lands before the
// previous page's code does mounts only the newest page, and every lazy file
// is in the service worker's precache, so each page still opens offline.
const { test, expect } = require('@playwright/test');
const { fence, signIn, signUp } = require('./helpers');

/** Hash -> a selector only that page draws. */
const PAGES = {
  '#/places': '.list-tab[aria-current="page"][href="#/places"]',
  '#/routes': '.list-tab[aria-current="page"][href="#/routes"]',
  '#/areas': '.list-tab[aria-current="page"][href="#/areas"]',
  '#/history': '#app .history-list, #app .app-state',
  '#/you': '#app .you-head, #app .you-signin',
};

test('a fast hash change mounts only the newest list page', async ({ page, baseURL }) => {
  await fence(page, /** @type {string} */ (baseURL));
  const requested = /** @type {string[]} */ ([]);
  /** @type {(() => void) | undefined} */
  let release;
  const held = new Promise(resolve => { release = () => resolve(undefined); });
  await page.route('**/app/places/places-page.js', async route => {
    requested.push(route.request().url());
    await held;
    await route.fallback();
  });
  await signIn(page);
  expect(requested, 'the places page is not part of the first load').toEqual([]);

  // A starts and stalls on its import; B arrives and finishes first.
  await page.evaluate(() => { location.hash = '#/places'; });
  await expect.poll(() => requested.length).toBe(1);
  await page.evaluate(() => { location.hash = '#/routes'; });
  await expect(page.locator(PAGES['#/routes'])).toBeAttached();

  // A's code arrives late and must not mount over B.
  /** @type {() => void} */ (release)();
  await page.evaluate(() => import('/app/places/places-page.js'));
  await page.waitForTimeout(300);
  await expect(page.locator(PAGES['#/routes'])).toBeAttached();
  await expect(page.locator(PAGES['#/places'])).toHaveCount(0);
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('each list page opens offline after one online load', async ({ page, context }, info) => {
    await signUp(page, info);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await context.setOffline(true);
    for (const [hash, marker] of Object.entries(PAGES)) {
      await page.goto('/' + hash);
      await expect(page.locator(marker).first(), hash).toBeAttached();
    }
  });
});
