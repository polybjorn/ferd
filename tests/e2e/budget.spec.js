// Budget: the JS, CSS and HTML of the first load, tiles and GPX excluded
// (docs/architecture.md, Platform targets). Measured from the responses the
// page receives, so a vendored file or an eager import counts.
//
// The limit is the load as it stands plus headroom for small fixes. It is a
// ratchet, not a target: growing past it means raising it in the same PR,
// where the reason gets read. A change that shrinks the load can lower it.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

const BUDGET = 943 * 1000;
const COUNTED = /^(text\/(html|css|javascript)|application\/(javascript|x-javascript))\b/;

test('the first load stays under its budget of JS, CSS and HTML', async ({ page, baseURL }) => {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  /** @type {Map<string, number>} */
  const sizes = new Map();
  page.on('response', async res => {
    const url = new URL(res.url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) return;
    if (!COUNTED.test(res.headers()['content-type'] || '')) return;
    const body = await res.body().catch(() => Buffer.alloc(0));
    sizes.set(url.pathname, body.length);
  });

  await signIn(page);
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const top = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([path, n]) => `${(n / 1000).toFixed(1)} KB ${path}`).join('\n');
  expect(fenced.external).toEqual([]);
  expect(sizes.size, 'responses counted').toBeGreaterThan(0);
  expect(total, `${(total / 1000).toFixed(1)} KB over ${sizes.size} files; largest:\n${top}`).toBeLessThan(BUDGET);
});
