// The list pages load through import() the first time each is opened
// (app/router.js). Three things must hold: a hash change that lands before the
// previous page's code does mounts only the newest page, a page left for
// another comes back as it was left (app/view.js), and every lazy file is in
// the service worker's precache, so each page still opens offline.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signIn, signUp } = require('./helpers');

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

test('a list page left for another and the map comes back as it was left', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  // The demo's places outgrow a short window, so there is a scroll to keep.
  if (!isPhone(info)) await page.setViewportSize({ width: 1024, height: 480 });
  await signIn(page, '#/places');
  await expect(page.locator('.place-card').first()).toBeVisible();
  const app = page.locator('#app');
  const y = await app.evaluate(el => { el.scrollTop = Math.min(240, el.scrollHeight - el.clientHeight); return el.scrollTop; });
  expect(y, 'the list is long enough to scroll').toBeGreaterThan(100);
  await page.locator('.place-card').first().evaluate(el => { /** @type {HTMLElement} */ (el).dataset.e2eKept = ''; });

  await page.evaluate(() => { location.hash = '#/areas'; });
  await expect(page.locator(PAGES['#/areas'])).toBeAttached();
  await expect(page.locator('.place-card'), 'the page left is out of the document').toHaveCount(0);
  await page.evaluate(() => { location.hash = '#/'; });
  await expect(page.locator('#map')).toBeAttached();
  await page.evaluate(() => { location.hash = '#/places'; });
  await expect(page.locator(PAGES['#/places'])).toBeAttached();
  // Two frames, for the scroll event the restore fires.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  await expect(page.locator('.place-card[data-e2e-kept]'), 'the same cards, not a rebuild').toHaveCount(1);
  expect(await app.evaluate(el => el.scrollTop)).toBe(y);
  const entrances = await page.locator('#app .fade-in').evaluateAll(els => els.map(el => getComputedStyle(el).animationName));
  expect(entrances.length).toBeGreaterThan(0);
  expect(entrances.filter(name => name !== 'none'), 'no group fades in again').toEqual([]);
  await expect(page.locator('#add-place-btn'), 'the Add the router cleared is back').toBeAttached();
  if (isPhone(info)) await expect(page.locator('body'), 'the return is not a scroll down').not.toHaveClass(/bar-away/);
  expect(fenced.errors).toEqual([]);
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
