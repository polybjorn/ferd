// Catalog updates: places imported from the shipped catalog whose entry has
// moved on, reviewed one at a time and in bulk. Santoni is the catalog entry
// with no image, so no diff loads one from outside the test server.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp, dialog } = require('./helpers');

const SANTONI = {
  lat: 37.05794, lon: 14.89506, category: 'religious', tags: ['Greek'], country: 'Italy',
  sources: ['https://en.wikipedia.org/wiki/Santoni'], from_catalog: 'Santoni',
};
const NOTE = 'Twelve rock-cut reliefs of the goddess Cybele';

/**
 * Write places straight to the account, then reload so the app pulls them.
 * Each one is Santoni with an older note, so its catalog entry differs.
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} names id -> name
 */
async function seed(page, names) {
  const changes = Object.entries(names).map(([id, name]) => ({
    kind: 'place', id, op: 'put', data: { ...SANTONI, name, note: 'Old note' },
  }));
  const res = await page.request.post('/api/sync/batch', { data: { changes } });
  expect(res.ok(), `sync batch answered ${res.status()}`).toBe(true);
  await page.reload();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
}

async function openPlacesList(/** @type {import('@playwright/test').Page} */ page, /** @type {boolean} */ phone) {
  if (phone) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/places"]').click();
  } else {
    await page.locator('#tab-places').click();
  }
  await expect(page.locator('#search-input')).toBeVisible();
}

/** Open the bulk review: the chip on Places, which a phone moves to the You page's sheet. */
async function openBulkReview(/** @type {import('@playwright/test').Page} */ page, /** @type {boolean} */ phone) {
  if (phone) {
    await page.locator('#bar-you').click();
    await page.locator('#you-gear').click();
    await page.locator('.account-sheet [data-action=catalog-updates]').click();
  } else {
    await openPlacesList(page, phone);
    await page.locator('#catalog-update-review').click();
  }
}

test('applies a picked field from one place and keeps all on another', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);
  await seed(page, { a0000001: 'Santoni', a0000002: 'Santoni kept' });
  const phone = isPhone(info);
  await openPlacesList(page, phone);
  if (!phone) await expect(page.locator('#catalog-update-review')).toBeVisible();

  const card = (/** @type {string} */ name) => page.locator('.place-card').filter({ has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) });
  // A wide screen opens it from the card's context menu, a phone from its mark.
  if (phone) {
    await card('Santoni').locator('.catalog-mark.update-available').click();
  } else {
    await card('Santoni').click({ button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu.locator('button').filter({ hasText: 'Apply catalog update' })).toBeVisible();
    await menu.locator('button').filter({ hasText: 'Apply catalog update' }).click();
    await expect(menu).toHaveCount(0);
  }
  let modal = dialog(page);
  await expect(modal.locator('h2')).toHaveText('Update from catalog');
  await expect(modal.locator('.catalog-diff-new')).toHaveText([NOTE]);
  const keep = modal.locator('#catalog-update-skip');
  await expect(keep).toBeEnabled();
  await modal.locator('.catalog-diff-check[data-field="note"]').check();
  await expect(keep).toBeDisabled();
  await modal.locator('#catalog-update-confirm').click();
  await expect(modal).toBeHidden();
  await expect(card('Santoni').locator('.catalog-mark')).not.toHaveClass(/update-available/);

  // The other one has a name change too; Keep all records both as skipped.
  await card('Santoni kept').locator('.catalog-mark.update-available').click();
  modal = dialog(page);
  await expect(modal.locator('.catalog-diff-label')).toHaveText(['Name', 'Note']);
  await modal.locator('#catalog-update-skip').click();
  await expect(modal).toBeHidden();
  await expect(card('Santoni kept').locator('.catalog-mark')).not.toHaveClass(/update-available/);
  await expect(page.locator('#catalog-update-review')).toBeHidden();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('bulk review applies what is ticked and shows the places that failed', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);
  await seed(page, { b0000001: 'Santoni', b0000002: 'Santoni fails' });
  await openBulkReview(page, isPhone(info));
  const modal = dialog(page);
  await expect(modal.locator('h2')).toHaveText('Catalog updates (2)');

  const apply = modal.locator('#catalog-bulk-apply');
  const toggleAll = modal.locator('#catalog-bulk-toggle-all');
  await expect(apply).toBeDisabled();
  await toggleAll.click();
  await expect(toggleAll).toHaveText('Uncheck all');
  await expect(modal.locator('.catalog-bulk-place-toggle')).toHaveText(['Clear', 'Clear']);
  await toggleAll.click();
  await expect(toggleAll).toHaveText('Check all');
  await expect(apply).toBeDisabled();

  // Only the notes, and the save of the second place fails on this device.
  await modal.locator('.catalog-diff-check[data-field="note"]').nth(0).check();
  await modal.locator('.catalog-diff-check[data-field="note"]').nth(1).check();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      if (JSON.stringify(args[0]).includes('Santoni fails')) throw new Error('disk full');
      return put.apply(this, args);
    };
  });
  await apply.click();

  const error = modal.locator('#catalog-bulk-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Applied with errors');
  await expect(error).toContainText('Santoni fails: disk full');
  await expect(error).not.toContainText('Santoni:');
  await expect(apply).toHaveText('Apply');

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
