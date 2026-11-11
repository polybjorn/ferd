// A modal closes on Esc and hands focus back to the control that opened it.
// On a phone, the bottom bar navigates, stays away through a double-tap zoom,
// comes and goes with a tap on the bare map, and a modal takes its phone layout.
const { test, expect } = require('@playwright/test');
const { fence, signIn, isPhone, dialog } = require('./helpers');

test('a modal closes on Esc and returns focus to its opener', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  const opener = page.locator('#map-add-btn:visible, #bar-add:visible');
  await opener.focus();
  await page.keyboard.press('Enter');
  const modal = dialog(page);
  await expect(page.locator('#add-tabs')).toBeVisible();
  // showModal moves focus into the dialog (or onto it, with no autofocus).
  await expect.poll(() => modal.evaluate(el => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);
  await expect(opener).toBeFocused();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the bottom bar navigates between views', async ({ page, baseURL }, info) => {
  test.skip(!isPhone(info), 'the bottom bar is the phone layout');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  const current = page.locator('#bottom-bar [aria-current="page"]');
  await expect(current).toHaveId('bar-map');
  // The bar replaces the header tabs, and ui.css's tab display outranks a
  // plain display: none from the app layer.
  await expect(page.locator('.app-nav .nav-tabs')).toBeHidden();

  await page.locator('#bar-lists').click();
  await expect(current).toHaveId('bar-lists');
  await expect(page.locator('.list-tabs')).toBeVisible();
  await expect(page.locator('.leaflet-container')).toHaveCount(0);

  await page.locator('#bar-you').click();
  await expect(current).toHaveId('bar-you');
  await expect(page).toHaveURL(/#\/you$/);
  await expect(page.locator('#you-gear')).toBeVisible();

  await page.locator('#bar-map').click();
  await expect(current).toHaveId('bar-map');
  await expect(page.locator('.leaflet-container').first()).toBeVisible();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a double-tap zoom keeps the moved-away bottom bar away', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'android', 'the bottom bar is the phone layout, and WebKit\'s emulated taps never zoom the map');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  const map = page.locator('#map');
  await page.waitForSelector('#map .leaflet-tile-loaded', { state: 'attached' });

  await map.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('body')).toHaveClass(/\bbar-away\b/);

  // A class check after the zoom would miss the bar showing for a moment, so
  // every change to it is logged as it happens.
  await page.evaluate(() => {
    const log = /** @type {string[]} */ ([]);
    Object.assign(window, { barLog: log });
    const container = /** @type {Element} */ (document.querySelector('#map'));
    new MutationObserver(() => {
      if (!document.body.classList.contains('bar-away')) log.push('shown');
    }).observe(document.body, { attributeFilter: ['class'] });
    new MutationObserver(() => {
      if (container.querySelector('.leaflet-zoom-anim')) log.push('zoom');
    }).observe(container, { attributeFilter: ['class'], subtree: true });
  });
  const box = await map.boundingBox();
  if (!box) throw new Error('the map has no box');
  const x = box.x + 80, y = box.y + box.height / 3;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(90);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => /** @type {any} */ (window).barLog);
  expect(log).toContain('zoom');
  expect(log).not.toContain('shown');

  await page.touchscreen.tap(x, y);
  await expect(page.locator('body')).not.toHaveClass(/\bbar-away\b/);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a tap on the bare map toggles the bottom bar, and the credit stays clear of the corner', async ({ page, baseURL }, info) => {
  test.skip(!isPhone(info), 'the bottom bar is the phone layout');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  const map = page.locator('#map');
  const body = page.locator('body');
  await page.waitForSelector('#map .leaflet-tile-loaded', { state: 'attached' });
  const box = await map.boundingBox();
  if (!box) throw new Error('the map has no box');
  const x = box.x + 80, y = box.y + box.height / 3;

  await page.touchscreen.tap(x, y);
  await expect(body).toHaveClass(/\bbar-away\b/);
  // A popup here would mean the tap found a route, pin or area, not bare map.
  await expect(page.locator('#map .leaflet-popup')).toHaveCount(0);

  // Each shown control in the bottom-right corner, the credit or its button,
  // keeps --ui-corner-gap from both screen edges once the bar is away.
  await expect.poll(() => page.evaluate(() => {
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-corner-gap'));
    const shown = [...document.querySelectorAll('#map .leaflet-bottom.leaflet-right .leaflet-control')]
      .filter(c => c.getClientRects().length);
    const clear = shown.every(c => {
      const r = c.getBoundingClientRect();
      return innerWidth - r.right >= gap - 0.5 && innerHeight - r.bottom >= gap - 0.5;
    });
    return shown.length > 0 && clear;
  })).toBe(true);

  // The first tap collapsed the credit to its button. A tap on that is aimed
  // at the credit, so the bar stays as it is, away here and showing below.
  await page.locator('#map .map-credit-toggle').tap();
  await expect(page.locator('#map .leaflet-control-attribution')).toBeVisible();
  // It grows in from the corner rather than appearing at once.
  await expect(page.locator('#map .leaflet-control-attribution')).toHaveCSS('animation-name', 'credit-in');
  await page.waitForTimeout(500);
  await expect(body).toHaveClass(/\bbar-away\b/);

  await page.touchscreen.tap(x, y);
  await expect(body).not.toHaveClass(/\bbar-away\b/);

  await page.locator('#map .map-credit-toggle').tap();
  await expect(page.locator('#map .leaflet-control-attribution')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(body).not.toHaveClass(/\bbar-away\b/);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a tap that closes the tile picker leaves the bottom bar as it is', async ({ page, baseURL }, info) => {
  test.skip(!isPhone(info), 'the bottom bar is the phone layout');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  const body = page.locator('body');
  const picker = page.locator('#map .leaflet-control-layers');
  await page.waitForSelector('#map .leaflet-tile-loaded', { state: 'attached' });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('the map has no box');

  // A tap on the button opens the picker through emulated mouse events whose
  // timing varies, and Enter opens it the same way every time.
  await page.locator('#map .leaflet-control-layers-toggle').press('Enter');
  await expect(picker).toHaveClass(/leaflet-control-layers-expanded/);
  await page.touchscreen.tap(box.x + 80, box.y + box.height / 3);
  await expect(picker).not.toHaveClass(/leaflet-control-layers-expanded/);
  await page.waitForTimeout(500);
  await expect(body).not.toHaveClass(/\bbar-away\b/);

  // With the picker closed, the same tap reads as bare map again.
  await page.touchscreen.tap(box.x + 80, box.y + box.height / 3);
  await expect(body).toHaveClass(/\bbar-away\b/);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the header Add button survives a list page', async ({ page, baseURL }, info) => {
  test.skip(isPhone(info), 'the phone has no header actions');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  const add = page.locator('#nav-actions button');
  await expect(add).toHaveCount(1);

  await page.locator('#tab-places').click();
  await expect(add).toHaveCount(1);
  await page.locator('#nav-home').click();
  await expect(page.locator('#map-add-btn')).toBeVisible();
  // Preact runs the list page's effect cleanup after the next paint, once the
  // map has put its button in, so look again past that point without retrying.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 100))));
  expect(await add.count()).toBe(1);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

for (const width of [320, 412]) {
  test(`a modal takes the phone layout at ${width}px`, async ({ page, baseURL }, info) => {
    test.skip(!isPhone(info), 'the phone layout is the phone projects\' concern');
    const fenced = await fence(page, /** @type {string} */ (baseURL));
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);

    await page.locator('#bar-add').click();
    await expect(page.locator('#add-tabs')).toBeVisible();
    const modal = dialog(page);
    await expect(modal).toHaveClass(/\bui-dialog-(sheet|fullscreen|top)\b/);
    // Wait out the open animation before measuring.
    await expect.poll(() => modal.evaluate(el => el.getAnimations().length)).toBe(0);
    const box = await modal.boundingBox();
    expect(box, 'the dialog has a box').not.toBeNull();
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (box);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5);
    // Nothing inside the dialog runs wider than the dialog.
    const overflow = await modal.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow, 'horizontal overflow inside the dialog').toBeLessThanOrEqual(0);

    expect(fenced.external).toEqual([]);
    expect(fenced.errors).toEqual([]);
  });
}
