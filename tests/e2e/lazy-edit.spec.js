// The place Edit dialog and the map context menu load on first use. The first
// load must not fetch them, both must open once they are asked for, and two
// quick actions while a module is in flight must open one dialog or one menu.
const { test, expect } = require('@playwright/test');
const { fence, signUp, dialog, isPhone } = require('./helpers');

const NAME = 'E2E lazy edit';

/** Hold a module's response so both actions land before it resolves. */
async function slow(/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ glob, /** @type {string[]} */ requested) {
  await page.route(glob, async route => {
    requested.push(route.request().url());
    await new Promise(r => setTimeout(r, 800));
    await route.fallback();
  });
}

/** Seed one place and open its popup from a focus link. */
async function seedAndOpenPopup(/** @type {import('@playwright/test').Page} */ page, /** @type {import('@playwright/test').TestInfo} */ info) {
  await signUp(page, info);
  const created = await page.request.post('/api/sync/batch', {
    data: { changes: [{ kind: 'place', op: 'put', id: 'e2e0ab34', data: { name: NAME, lat: 46.47, lon: 9.82 } }] },
  });
  expect(created.ok(), `sync answered ${created.status()}`).toBe(true);
  // A focus link opens the pin's popup without visiting a list page, which
  // would load the same modules. It follows the sync that brings the place in.
  await page.reload();
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => { location.hash = '#/place/e2e-lazy-edit'; });
  const popup = page.locator('.leaflet-popup').filter({ hasText: NAME });
  await expect(popup).toBeVisible();
  return popup;
}

test('the place Edit dialog loads on first use and a double click opens one', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const requested = /** @type {string[]} */ ([]);
  await slow(page, '**/app/places/edit-place.js', requested);
  const popup = await seedAndOpenPopup(page, info);
  expect(requested, 'edit-place.js is not part of the first load').toEqual([]);

  // Both clicks run in one task, as a fast double tap does before the import settles.
  await popup.getByRole('button', { name: 'Edit' }).evaluate(b => { b.click(); b.click(); });
  await expect(dialog(page).getByRole('textbox', { name: /^Name\b/ })).toHaveValue(NAME);
  await page.waitForTimeout(500);
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(1);
  expect(requested).toHaveLength(1);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the map context menu loads on first use and opens one menu', async ({ page, baseURL }, info) => {
  test.skip(isPhone(info), 'right-click is the desktop path; a phone long-presses');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const requested = /** @type {string[]} */ ([]);
  await slow(page, '**/app/context-menu.js', requested);
  await seedAndOpenPopup(page, info);
  expect(requested, 'context-menu.js is not part of the first load').toEqual([]);

  // The focus link centres the pin; two right-clicks land on it.
  await page.keyboard.press('Escape');
  const box = await page.locator('.leaflet-container').first().boundingBox();
  if (!box) throw new Error('the map has no box');
  const at = { x: box.width / 2, y: box.height / 2 };
  const container = page.locator('.leaflet-container').first();
  await container.click({ button: 'right', position: at });
  await container.click({ button: 'right', position: at });

  const menu = page.locator('.context-menu');
  await expect(menu).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  expect(requested).toHaveLength(1);

  // Its Edit entry reaches the lazy dialog.
  await menu.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(dialog(page).getByRole('textbox', { name: /^Name\b/ })).toHaveValue(NAME);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
