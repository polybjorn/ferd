// Accessibility: axe-core on the map, Places, Routes, Settings and a place's
// edit form, in every theme and both modes. The target is no serious or
// critical violation (docs/architecture.md, Platform targets).
//
// The demo account only reads here, so the projects can share it. The theme
// is set on <html> after each navigation: the account's synced theme would
// otherwise replace one set before load.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { fence, isPhone, signIn, dialog } = require('./helpers');

// Thirty independent read-only scans: run serially, this file alone set the
// browser tests' wall-clock in every project.
test.describe.configure({ mode: 'parallel' });

const THEMES = ['catppuccin', 'dracula', 'gruvbox', 'nord', 'rose-pine', 'solarized', 'tokyo-night'];
const MODES = ['light', 'dark'];
// Axe reads contrast and roles from the DOM and computed styles, which the
// engines agree on; what differs is the layout. One desktop and one phone
// project cover both layouts at half the CPU of the theme scans in all four.
const SCAN_PROJECTS = ['chromium', 'iphone'];
const SCAN_SKIP = 'theme scans run in one desktop and one phone project';

/** Serious and critical violations on the page now, as "rule (n nodes)" lines. */
async function violations(/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ where) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => `${where}: ${v.id} [${v.impact}] on ${v.nodes.length} node(s), e.g. ${v.nodes[0].target.join(' ')} ${v.nodes[0].any[0]?.message ?? ''}`);
}

async function applyTheme(/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ theme, /** @type {string} */ mode) {
  await page.evaluate(([t, m]) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.mode = m;
  }, [theme, mode]);
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`no serious or critical violations in ${theme} ${mode}`, async ({ page, baseURL }, info) => {
      test.skip(!SCAN_PROJECTS.includes(info.project.name), SCAN_SKIP);
      const fenced = await fence(page, /** @type {string} */ (baseURL));
      const phone = isPhone(info);
      const found = [];
      /** Check the view that is open now, in the theme under test. */
      const check = async (/** @type {string} */ view) => {
        await applyTheme(page, theme, mode);
        // Park the pointer off the tabs; the hover case below covers them.
        await page.mouse.move(0, 0);
        found.push(...await violations(page, `${view} (${theme} ${mode})`));
      };

      await signIn(page);
      // Colour transitions would let axe read a half-way colour as the
      // contrast. A constructed sheet, since style-src 'self' refuses a <style>.
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      await expect(page.locator('.leaflet-container').first()).toBeVisible();
      await check('map');

      // Places, and the edit form for its first place.
      if (phone) {
        await page.locator('#bar-lists').click();
        await page.locator('.list-tab[href="#/places"]').click();
      } else {
        await page.locator('#tab-places').click();
        await expect(page.locator('#tab-places')).toHaveAttribute('aria-current', 'page');
      }
      await expect(page.locator('.place-card').first()).toBeVisible();
      await check('places');

      await page.locator('.place-card').first().click();
      await page.locator('.leaflet-popup').getByRole('button', { name: 'Edit' }).click();
      await expect(dialog(page).locator('h2')).toHaveText('Edit place');
      await check('edit place');
      await page.keyboard.press('Escape');
      await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

      // Routes.
      if (phone) {
        await page.locator('#bar-lists').click();
        await page.locator('.list-tab[href="#/routes"]').click();
      } else {
        await page.locator('#tab-routes').click();
        await expect(page.locator('#tab-routes')).toHaveAttribute('aria-current', 'page');
      }
      await expect(page.locator('.route-card').first()).toBeVisible();
      await check('routes');

      // Settings.
      await page.locator('#auth-menu-btn:visible, #bar-you:visible').click();
      await page.locator('#auth-menu [data-action=settings]:visible, #you-gear:visible').click();
      await page.locator('.account-sheet [data-action=settings]:visible, #settings-tabs [aria-pressed="true"]').first().click();
      await expect(page.locator('#settings-tabs [data-tab="general"]')).toHaveAttribute('aria-pressed', 'true');
      await check('settings');

      expect(fenced.external).toEqual([]);
      expect(found).toEqual([]);
    });
  }
}

// The pointer stays on a tab after a click, and on a phone after a tap. Scan
// with it there, since a hover cue that dims the label fails contrast.
for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`no serious or critical violations with a hovered tab in ${theme} ${mode}`, async ({ page, baseURL }, info) => {
      test.skip(!SCAN_PROJECTS.includes(info.project.name), SCAN_SKIP);
      await fence(page, /** @type {string} */ (baseURL));
      const phone = isPhone(info);
      const found = [];
      await signIn(page);
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      await expect(page.locator('.leaflet-container').first()).toBeVisible();
      if (phone) await page.locator('#bar-lists').click();
      for (const view of ['places', 'routes']) {
        const tab = phone ? page.locator(`.list-tab[href="#/${view}"]`) : page.locator(`#tab-${view}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-current', 'page');
        await applyTheme(page, theme, mode);
        await tab.hover();
        await expect(tab).toBeVisible();
        found.push(...await violations(page, `${view} tab hovered (${theme} ${mode})`));
        // The other tab hovered while this one is current.
        const other = phone ? page.locator(`.list-tab[href="#/${view === 'places' ? 'routes' : 'places'}"]`) : page.locator(`#tab-${view === 'places' ? 'routes' : 'places'}`);
        await other.hover();
        found.push(...await violations(page, `${view} other tab hovered (${theme} ${mode})`));
      }
      expect(found).toEqual([]);
    });
  }
}

// The nav brand is the map's one h1. A phone shows it over the map's top
// edge, clear of the zoom control and the phone buttons, down to 320px.
test('the map names itself in one visible h1', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  if (isPhone(info)) await page.setViewportSize({ width: 320, height: 800 });
  await signIn(page);
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  const h1 = page.locator('h1:visible');
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveClass(/nav-brand/);
  if (isPhone(info)) {
    const box = await h1.boundingBox();
    for (const sel of ['.leaflet-control-zoom', '.map-phone-buttons']) {
      const other = await page.locator(sel).first().boundingBox();
      if (!box || !other) throw new Error(`no box for the h1 or ${sel}`);
      const apart = box.x + box.width <= other.x || other.x + other.width <= box.x
        || box.y + box.height <= other.y || other.y + other.height <= box.y;
      expect(apart, `the h1 overlaps ${sel}`).toBe(true);
    }
  }
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

// The main element takes focus only from the skip link: focusable for good,
// it takes a clicked button's focus in Safari and closes an open menu.
test('the skip link focuses the main element, which lets go of focus after', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page, '#/places');
  await expect(page.locator('.place-card').first()).toBeVisible();
  const main = page.locator('#app');
  await expect(main).not.toHaveAttribute('tabindex');

  await page.locator('#skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(main).toBeFocused();
  await expect(page).toHaveURL(/#\/places$/);
  await page.keyboard.press('Tab');
  await expect(main).not.toBeFocused();
  await expect(main).not.toHaveAttribute('tabindex');
  expect(fenced.errors).toEqual([]);
});

// site-audit's widths, split at the 600px phone breakpoint. The audit wants
// one visible h1 at each, and a phone hides the nav brand off the map and a
// route, so there each list names itself: the current Lists tab, History's
// title, and the You page's name.
const PHONE_WIDTHS = [320, 360, 390, 414, 600];
const WIDE_WIDTHS = [768, 900, 1024, 1280, 1440];
const PHONE_NAMES = /** @type {Record<string, RegExp>} */ ({
  places: /^Places$/, routes: /^Routes$/, areas: /^Areas$/, history: /^History$/, you: /demo$/,
});

test('each view names itself in one visible h1 at every site-audit width', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const phone = isPhone(info);
  await signIn(page);
  const views = ['map', 'places', 'routes', 'areas', 'history', 'you'];
  const h1 = page.locator('h1:visible');
  for (const view of views) {
    await page.evaluate(v => { location.hash = v === 'map' ? '#/' : '#/' + v; }, view);
    for (const width of phone ? PHONE_WIDTHS : WIDE_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      const at = `${view} at ${width}px`;
      if (!phone || view === 'map') {
        await expect(h1, at).toHaveClass(/nav-brand/);
      } else {
        await expect(h1, at).toHaveText(PHONE_NAMES[view]);
      }
      await expect(h1, at).toHaveCount(1);
    }
  }
  // Still on You: the h1 moves with the layout as the width crosses 600px.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(h1).toHaveText(PHONE_NAMES.you);
  await page.setViewportSize({ width: 768, height: 800 });
  // The count first: strict mode fails at once while Preact catches up.
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveClass(/nav-brand/);
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
