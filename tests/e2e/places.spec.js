// A place's whole life: add it with typed coordinates, find it in the list
// and on the map, rename it, and delete it.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp, dialog } = require('./helpers');

/** Open the Places list, on a phone through Lists and its tab. */
async function openPlacesList(/** @type {import('@playwright/test').Page} */ page, /** @type {boolean} */ phone) {
  if (phone) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/places"]').click();
  } else {
    await page.locator('#tab-places').click();
  }
  await expect(page.locator('#search-input')).toBeVisible();
}

/** From the list, open the place's popup on the map and its Edit dialog. */
async function editFromList(/** @type {import('@playwright/test').Page} */ page, /** @type {boolean} */ phone, /** @type {string} */ name) {
  await openPlacesList(page, phone);
  const card = await placeCard(page, name);
  await card.click();
  const popup = page.locator('.leaflet-popup').filter({ hasText: name });
  await expect(popup).toBeVisible();
  await popup.getByRole('button', { name: 'Edit' }).click();
  const edit = dialog(page);
  await expect(edit.locator('h2')).toHaveText('Edit place');
  await expect(edit.locator('#e-name')).toHaveValue(name);
  return edit;
}

/** The card for one place, found through the list's search box. */
async function placeCard(/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) {
  await page.locator('#search-input').fill(name);
  return page.locator('.place-card').filter({ has: page.locator('.name', { hasText: name }) });
}

test('adds a place, shows it, edits it and deletes it', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E place';
  const renamed = name + ' renamed';
  const phone = isPhone(info);
  await signUp(page, info);

  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await expect(page.locator('#add-tabs')).toBeVisible();
  await page.locator('#p-name').fill(name);
  await page.locator('#p-coords-manual').click();
  await page.locator('#p-lat').fill('46.47');
  await page.locator('#p-lon').fill('9.82');
  await page.locator('#place-submit').click();
  await expect(page.locator('#add-tabs')).toBeHidden();

  // The list shows it, and a click on its card opens it on the map.
  let edit = await editFromList(page, phone, name);
  await edit.locator('#e-name').fill(renamed);
  await edit.locator('#e-name').press('Enter');
  await expect(edit).toBeHidden();

  edit = await editFromList(page, phone, renamed);
  await edit.locator('#e-delete').click();
  const confirm = dialog(page);
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  await openPlacesList(page, phone);
  await expect(await placeCard(page, renamed)).toHaveCount(0);
  // The store syncs the delete to the server after the fact.
  await expect.poll(async () => {
    const places = await (await page.request.get('/api/places')).json();
    return places.map((/** @type {{ name: string }} */ p) => p.name);
  }, { timeout: 15_000 }).not.toContain(renamed);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
