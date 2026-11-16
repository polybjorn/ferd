'use strict';
// Fails when the installed Playwright expects browser builds the CI image does
// not carry. Without it the mismatch surfaces minutes later as every test
// failing to launch a browser, which reads like a broken suite.
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (!root) {
  console.error('check-playwright-image: PLAYWRIGHT_BROWSERS_PATH is unset; this runs on the Playwright image only');
  process.exit(2);
}

// browsers.json is not in playwright-core's exports map, so it is read beside
// the package's main entry rather than resolved by name.
const pkgDir = path.dirname(require.resolve('playwright-core'));
const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const wanted = JSON.parse(readFileSync(path.join(pkgDir, 'browsers.json'), 'utf8')).browsers
  .filter(b => b.installByDefault)
  .map(b => `${b.name.replace(/-/g, '_')}-${b.revision}`);
const missing = wanted.filter(dir => !existsSync(path.join(root, dir)));

if (missing.length) {
  console.error(`Playwright ${version} wants ${missing.join(', ')}, which ${root} lacks.`);
  console.error('Move the e2e container image in .forgejo/workflows/ci.yml to the same release as package.json.');
  process.exit(1);
}
console.log(`Playwright ${version}: the image carries ${wanted.join(', ')}`);
