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

const THEMES = ['catppuccin', 'dracula', 'gruvbox', 'nord', 'rose-pine', 'solarized', 'tokyo-night'];
const MODES = ['light', 'dark'];

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
