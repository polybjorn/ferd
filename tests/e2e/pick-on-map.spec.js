// Picking a place's position on the map: from the Add dialog the dialog
// closes for the map click and reopens with the typed name kept and the
// clicked coordinates filled in; clicking the banner cancels; the Edit dialog
// moves a saved place the same way. Each test signs up an account of its own.
const { test, expect } = require('@playwright/test');
const { fence, signUp, dialog, isPhone } = require('./helpers');

const BANNER = /Click on the map to set coordinates/;

/** Click the middle of the map, clear of the panels and the bottom bar. */
async function clickMap(/** @type {import('@playwright/test').Page} */ page) {
  const box = await page.locator('.leaflet-container').first().boundingBox();
  if (!box) throw new Error('the map has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
}

/** Open the Add dialog from the map's add button or the phone's bottom bar. */
async function openAdd(/** @type {import('@playwright/test').Page} */ page) {
  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await expect(dialog(page).getByRole('button', { name: 'Pick on map' })).toBeVisible();
}

/** The "lat, lon" text the dialog shows after a pick, as numbers. */
async function shownCoords(/** @type {import('@playwright/test').Page} */ page) {
  const text = await dialog(page).getByText(/^-?\d+\.\d{5}, -?\d+\.\d{5}$/).innerText();
  const [lat, lon] = text.split(', ').map(Number);
  return { lat, lon };
}

test('a picked position fills the Add dialog and saves with the place', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E picked place';
  await signUp(page, info);

  await openAdd(page);
  await dialog(page).getByRole('textbox', { name: /^Name\b/ }).fill(name);
  await dialog(page).getByRole('button', { name: 'Pick on map' }).click();

  await expect(page.getByText(BANNER)).toBeVisible();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);
  await clickMap(page);
  await expect(page.getByText(BANNER)).toBeHidden();

  // The draft comes back with the name kept and the button reworded.
  const form = dialog(page);
  await expect(form.getByRole('textbox', { name: /^Name\b/ })).toHaveValue(name);
  await expect(form.getByRole('button', { name: 'Re-pick on map' })).toBeVisible();
  const picked = await shownCoords(page);

  await form.getByRole('button', { name: 'Add place' }).click();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);
  await expect.poll(async () => {
    const places = await (await page.request.get('/api/places')).json();
    return places.find((/** @type {{ name: string }} */ p) => p.name === name);
  }, { timeout: 15_000 }).toMatchObject({
    lat: expect.closeTo(picked.lat, 4),
    lon: expect.closeTo(picked.lon, 4),
  });

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('clicking the banner cancels the pick and leaves the map usable', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);

  await openAdd(page);
  await dialog(page).getByRole('button', { name: 'Pick on map' }).click();
  await page.getByText(BANNER).click();
  await expect(page.getByText(BANNER)).toBeHidden();

  // A later map click must not open the Add dialog: the pick mode is gone.
  await clickMap(page);
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the Edit dialog moves a saved place to a picked position', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E moved place';
  await signUp(page, info);
  const id = 'e2e0ab12';
  const created = await page.request.post('/api/sync/batch', {
    data: { changes: [{ kind: 'place', op: 'put', id, data: { name, lat: 46.47, lon: 9.82 } }] },
  });
  expect(created.ok(), `sync answered ${created.status()}`).toBe(true);
  // The page loaded before the place existed, so it needs a fresh load to see
  // it. A click on its list card opens its popup on the map.
  await page.reload();
  if (isPhone(info)) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/places"]').click();
  } else {
    await page.locator('#tab-places').click();
  }
  await page.locator('.place-card').filter({ hasText: name }).click();

  const popup = page.locator('.leaflet-popup').filter({ hasText: name });
  await expect(popup).toBeVisible();
  await popup.getByRole('button', { name: 'Edit' }).click();
  await dialog(page).getByRole('button', { name: 'Pick on map' }).click();
  await expect(page.getByText(BANNER)).toBeVisible();
  await clickMap(page);

  const edit = dialog(page);
  await expect(edit.getByRole('textbox', { name: /^Name\b/ })).toHaveValue(name);
  await edit.getByRole('textbox', { name: /^Name\b/ }).press('Enter');
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  await expect.poll(async () => {
    const places = await (await page.request.get('/api/places')).json();
    const p = places.find((/** @type {{ name: string }} */ q) => q.name === name);
    return p && Math.abs(p.lat - 46.47) + Math.abs(p.lon - 9.82) > 0.001;
  }, { timeout: 15_000 }).toBe(true);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
